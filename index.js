const fileUpload = require('express-fileupload');
const findFreePort = require('find-free-port');
const bodyParser = require('body-parser');
const decompress = require('decompress');
const download = require('download');
const Docker = require('dockerode');
const express = require('express');
const fs = require('fs-extra');
const cp = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');



// think of install
// think of startup
// think of query server
// think of stream server
// think of supporting more engines
// think of supporting dbs
// think of linking componenets with env (singleton?)
// think of web interface
// DEVICE, QUERY, SERVICE, PROCESS, PORT, ENV
// post upon exists -> restart all processes
// /restart, /stop
// direct service, process, file access, zip
// per process env, SERVICE PROCESS PORT
// service /restart -> all restart
// read config with defaults and system local (from mem)
// list service processes
// list process service
// how to know if process stopped, crashed
// events websocket to control server
// active processes, active listeners (ref counting)
// readonly mount tensorflow serving, copy mount others
// use dockerode for all docker commands
const PORT = '8080';
const SERVICEPATH = __dirname+'/data/service';
const PROCESSPATH = __dirname+'/data/process';
const CONFIG = __dirname+'/data/config.json';
const CONFIGFILE = 'config.json';
// exec
// cp
const OSFN = [
  'arch', 'cpus', 'endianness', 'freemem', 'homedir', 'hostname',
  'loadavg', 'networkInterfaces', 'platform', 'release', 'tmpdir',
  'totalmem', 'type', 'uptime', 'userInfo'
];
const STDIO = [0, 1, 2];
const NOP = () => 0;

const app = express();
const docker = new Docker();
const services = {};
const models = services;



const errNoService = (res, name) => (
  res.status(404).json('Cant find service '+name)
);
const errServiceExists = (res, name) => (
  res.status(405).json('Service '+name+' already exists')
);

const configDefault = () => ({
  engine: 'python:3',
  created: new Date(),
  processes: []
});



function arrayEnsure(val) {
  if(val==null) return [];
  return Array.isArray(val)? val:[val];
};

function cpExec(cmd, o) {
  var o = o||{}, stdio = o.log? o.stdio||STDIO:o.stdio||[];
  if(o.log) console.log('-cpExec:', cmd);
  if(o.stdio==null) return Promise.resolve({stdout: cp.execSync(cmd, {stdio})});
  return new Promise((fres, frej) => cp.exec(cmd, {stdio}, (err, stdout, stderr) => {
    return (err? frej:fres)({err, stdout, stderr});
  }));
}

async function dirDehusk(dir) {
  var ents = fs.readdirSync(dir, {withFileTypes: true});
  if(ents.length>1 || ents[0].isFile()) return;
  var temp = dir+'.temp', seed = path.join(temp, ents[0].name);
  await fs.move(dir, temp);
  await fs.move(seed, dir);
  await fs.remove(temp);
};

function downloadGit(dir, name, url) {
  return cpExec(`git clone --depth=1 ${url} ${name}`, {cwd: dir});
}

async function downloadUrl(dir, name, url) {
  var pkg = path.join(dir, name);
  var out = path.join(pkg, path.basename(url));
  fs.mkdirSync(pkg, {recursive: true});
  await download(url, pkg, {extract: true});
  await fs.remove(out);
  await dirDehusk(pkg);
}

async function downloadFile(dir, name, file) {
  var pkg = path.join(dir, name);
  var out = path.join(pkg, path.basename(file.name));
  fs.mkdirSync(pkg, {recursive: true});
  await new Promise((fres, frej) => file.mv(out, (err) => err? frej(err):fres()));
  await decompress(out);
  await fs.remove(out);
  await dirDehusk(pkg);
};

function downloadAny(dir, name, options) {
  var {git, url, file} = options||{};
  if(git) return downloadGit(dir, name, git);
  if(url) return downloadUrl(dir, name, url);
  return downloadFile(dir, name, file);
}

function configRead(dir) {
  var config = path.join(dir, CONFIGFILE);
  return fs.existsSync(config)? JSON.parse(fs.readFileSync(config, 'utf8')) : {};
}

function configWrite(dir, value) {
  var config = path.join(dir, CONFIGFILE);
  fs.writeFile(config, JSON.stringify(value, null, 2), NOP);
}

function configsRead(dir, configs={}) {
  for(var name of fs.readdirSync(dir))
    configs[name] = Object.assign(configRead(path.join(dir, name)), {name});
  return configs;
}

function configRunOptions(config) {
  var c = config||{}, o = {};
  const keys = ['ports', 'mounts', 'env', 'cmd'];
  o.path = path.join(SERVICEPATH, c.name);
  o.engine = c.engine||'python:3';
  for(var k of keys) {
    var v = c[k]||[];
    o[k] = typeof v==='string'? v.split(';'):v;
  }
  return o;
};

function optionsTensorflowServing(options) {
  var o = options||{};
  o.ports = [8500, 8501];
  o.mounts = [`type=bind,source=${o.path},target=/models/model`];
  o.env['MODEL_NAME'] = 'model';
};

function optionsPython3(options) {
  var o = options||{};
  o.ports = o.ports.length? o.ports:[8000];
  o.mounts = [`type=bind,source=${o.path},target=/usr/src/app`];// !!!
  o.env['PORT'] = o.ports[0].toString();
  o.cmd = ['sh', '/usr/src/app/run.sh'];// !!!
};

async function optionsCommand(options) {
  var {engine, ports, mounts, env, cmd} = options||{};
  var freePorts = await findFreePort(1024, 65535, '127.0.0.1', ports.length);
  var portsStr = ports.reduce((str, port, i) => str+` -p ${freePorts[i]}:${port}`, '');
  var mountsStr = mounts.reduce((str, mount) => str+` --mount ${mount}`, '');
  var envStr = Object.keys(env).reduce((str, k) => str+` -e ${k}=${env[k]}`, '');
  var cmdStr = cmd.join(' ');
  return `docker run -d ${portsStr} ${mountsStr} ${envStr} -it ${engine} ${cmdStr}`;
};



app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());
app.use(fileUpload());
app.use((req, res, next) => { Object.assign(req.body, req.query); next(); });

app.get('/service', (req, res) => {
  res.json(services);
});
app.post('/service', async (req, res) => {
  var {name, git, url} = req.body;
  var file = (req.files||{}).service;
  if(services[name]) return errServiceExists(res, name);
  await downloadAny(SERVICEPATH, name, {git, url, file});
  var dir = path.join(SERVICEPATH, name);
  await fs.copyFile(`${__dirname}/scripts/run_python3.sh`, `${dir}/run.sh`); // !!!
  services[name] = Object.assign(configRead(dir), req.body, configDefault());
  res.json(services[name]);
});
app.delete('/service/:name', async (req, res) => {
  var {name} = req.params;
  if(!services[name]) return errNoService(res, name);
  var jobs = [fs.remove(path.join(SERVICEPATH, name))];
  for(var id of services[name].processes)
    jobs.push(docker.getContainer(id).stop(req.body));
  await Promise.all(jobs);
  res.json(services[name] = null);
});
app.get('/service/:name', (req, res) => {
  var {name} = req.params;
  if(!services[name]) return errNoService(res, name);
  res.json(services[name]);
});
app.post('/service/:name', (req, res) => {
  var {name} = req.params;
  if(!services[name]) return errNoService(res, name);
  configWrite(path.join(SERVICEPATH, name), Object.assign(services[name], req.body, {name}));
  res.json(services[name]);
});
app.get('/service/:name/fs/*', (req, res) => {
  var {name} = req.params;
  var rel = req.url.replace(/\/service\/.*?\/fs\//, '');
  var abs = path.join(SERVICEPATH, name, rel);
  return res.sendFile(abs);
});
app.post('/service/:name/fs/*', async (req, res) => {
  var {name} = req.params, {file} = req.files;
  var rel = req.url.replace(/\/service\/.*?\/fs\//, '');
  var abs = path.join(SERVICEPATH, name, rel);
  await file.mv(abs);
  res.json(file.size);
});
// use copy mount strategy
app.post('/service/:name/run', async (req, res) => {
  var {name} = req.params;
  if(!services[name]) return errNoService(res, name);
  var o = configRunOptions(Object.assign(req.body, services[name]));
  if(o.engine==='tensorflow/serving') optionsTensorflowServing(o);
  else optionsPython3(o);
  var cmd = await optionsCommand(o);
  console.log({cmd});
  var {stdout, stderr} = await cpExec(cmd);
  var id = (stdout||stderr).toString().trim();
  var service = services[name];
  service.processes = service.processes||[];
  service.processes.push(id);
  var spath = path.join(SERVICEPATH, name);
  configWrite(spath, service);
  if(o.engine==='tensorflow/serving') return res.json(id);
  res.json(id);
});


// use status code?
app.get('/process', async (req, res) => {
  var options = req.body, filters = (options||{}).filters||{};
  for(var k in filters)
    filters[k] = arrayEnsure(filters[k]);
  var data = await docker.listContainers(options);
  res.json(data);
});
app.get('/process/:id', async (req, res) => {
  var {id} = req.params, options = req.body;
  var data = await docker.getContainer(id).inspect(options);
  res.json(data);
});
app.delete('/process/:id', async (req, res) => {
  var {id} = req.params, options = req.body;
  await docker.getContainer(id).stop(options);
  res.json(null);
});
app.get('/process/:id/export', async (req, res) => {
  var {id} = req.params;
  var stream = await docker.getContainer(id).export();
  res.writeHead(200, {'content-type': 'application/x-tar'});
  stream.pipe(res);
});
app.get('/process/:id/fs/*', (req, res) => {
  var {id} = req.params;
  var rel = req.url.replace(/\/process\/.*?\/fs\//, '');
  var abs = path.join(PROCESSPATH, id, rel);
  return res.sendFile(abs);
});
app.post('/process/:id/fs/*', async (req, res) => {
  var {id} = req.params, {file} = req.files;
  var rel = req.url.replace(/\/service\/.*?\/fs\//, '');
  var abs = path.join(PROCESSPATH, id, rel);
  await file.mv(abs);
  res.json(file.size);
});
app.all('/process/:id/:fn', async (req, res) => {
  var {id, fn} = req.params;
  var options = ['changes'].includes(fn)? undefined:req.body;
  var data = await docker.getContainer(id)[fn](options);
  res.json(data);
});


app.post('/shell', async (req, res) => {
  var {command} = req.body;
  var {stdout, stderr} = await cpExec(command);
  res.json({stdout, stderr});
});
app.get('/os', (req, res) => {
  var out = {};
  for(var fn of OSFN)
    out[fn] = os[fn]();
  res.json(out);
});
app.get('/os/:fn', (req, res) => {
  var {fn} = req.params;
  if(OSFN.includes(fn)) return res.json(os[fn]());
  res.status(404).json('Unknown function '+fn);
});
// we are not serving static files yet!



fs.mkdirSync(PROCESSPATH, {recursive: true});
fs.mkdirSync(SERVICEPATH, {recursive: true});
configsRead(SERVICEPATH, services);
const server = http.createServer(app);
server.on('clientError', (err, soc) => {
  soc.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
server.listen(PORT, () => {
  console.log('DEVICE running on port '+PORT);
});
