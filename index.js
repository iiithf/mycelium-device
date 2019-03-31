const fileUpload = require('express-fileupload');
const findFreePort = require('find-free-port');
const dockerNames = require('docker-names');
const finalhandler = require('finalhandler');
const serveStatic = require('serve-static');
const serveIndex = require('serve-index');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const express = require('express');
const fs = require('fs-extra');
const http = require('http');
const path = require('path');
const os = require('os');
const {arrayEnsure, cpExec} = require('./util');
const error = require('./error');
const fetch = require('./fetch');



const PORT = '8080';
const SERVICEPATH = __dirname+'/_data/service';
const PROCESSPATH = __dirname+'/_data/process';
const CONFIG = __dirname+'/_data/config.json';
const CONFIGFILE = 'config.json';
// exec
const OSFN = [
  'arch', 'cpus', 'endianness', 'freemem', 'homedir', 'hostname',
  'loadavg', 'networkInterfaces', 'platform', 'release', 'tmpdir',
  'totalmem', 'type', 'uptime', 'userInfo'
];
const NOP = () => 0;

const app = express();
const docker = new Docker();
const services = {};


const configDefault = () => ({
  engine: 'python:3',
  created: new Date(),
  processes: []
});


function configTfServing(o) {
  o.ports = [8500, 8501];
  o.mounts = ['type=bind,source=${path},target=/models/model'];
  o.env = o.env||{};
  o.env['MODEL_NAME'] = 'model';
  return o;
};

function configLang(o) {
  o.copyfs = true;
  o.ports = o.ports||[8000];
  o.mounts = ['type=bind,source=${path},target=/usr/src/app'];
  o.env = o.env||{};
  o.env['DEVICE'] = `127.0.0.1:${PORT}`;
  o.env['QUERY'] = `TODO`;
  o.env['SERVICE'] = o.name;
  o.env['PROCESS'] = `TODO`;
  o.env['PORT'] = o.ports[0].toString();
  o.workdir = o.workdir||'/usr/src/app';
  o.cmd = o.cmd||['sh', 'start.sh'];
  return o;
};

function configDef(o) {
  const keys = ['ports', 'mounts', 'env', 'cmd'];
  o.path = path.join(SERVICEPATH, o.name);
  o.version = o.version||0;
  o.engine = o.engine||'python:3';
  for(var k of keys) {
    var v = o[k]||null;
    o[k] = typeof v==='string'? v.split(';'):v;
  }
  if(o.engine==='tensorflow/serving') return configTfServing(o);
  return configLang(o);
};

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


async function commandRun(o, pname) {
  var ppath = o.copyfs? path.join(PROCESSPATH, pname):o;
  if(o.copyfs) await fs.copy(o.path, ppath);
  await fs.copy(__dirname+'/scripts/run_python3.sh', path.join(ppath, 'start.sh'));
  var workdir = `-w ${o.workdir}`, name = `--name ${pname}`;
  var freePorts = await findFreePort(1024, 65535, '127.0.0.1', o.ports.length);
  var ports = o.ports.reduce((str, port, i) => str+` -p ${freePorts[i]}:${port}`, '');
  var mounts = o.mounts.reduce((str, mount) => str+` --mount ${mount}`, '');
  var env = Object.keys(o.env).reduce((str, k) => str+` -e ${k}=${o.env[k]}`, '');
  var image = o.engine, cmd = o.cmd.join(' ');
  mounts = mounts.replace(/\$\{path\}/g, ppath);
  return `docker run -d ${workdir} ${name} ${ports} ${mounts} ${env} -it ${image} ${cmd}`;
};

function commandOptions(options, values=[], exclude=[]) {
  var o = options||{}, out = '';
  for(var k in o) {
    if(exclude.includes(k)) continue;
    if(!values.includes(k)) out += ` --${k}`;
    else out += ` --${k}`;
  }
  return out.trimStart();
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
  if(services[name]) return error.serviceExixts(res, name);
  await fetch({git, url, file}, SERVICEPATH, name);
  var dir = path.join(SERVICEPATH, name);
  await fs.copyFile(`${__dirname}/scripts/run_python3.sh`, `${dir}/run.sh`); // !!!
  services[name] = Object.assign(configRead(dir), req.body, configDefault());
  res.json(services[name]);
});
app.delete('/service/:name', async (req, res) => {
  var {name} = req.params;
  if(!services[name]) return error.noService(res, name);
  var jobs = [fs.remove(path.join(SERVICEPATH, name))];
  for(var id of services[name].processes)
    jobs.push(docker.getContainer(id).stop(req.body));
  await Promise.all(jobs);
  res.json(services[name] = null);
});
app.get('/service/:name', (req, res) => {
  var {name} = req.params;
  if(!services[name]) return error.noService(res, name);
  res.json(services[name]);
});
app.post('/service/:name', (req, res) => {
  var {name} = req.params;
  if(!services[name]) return error.noService(res, name);
  configWrite(path.join(SERVICEPATH, name), Object.assign(services[name], req.body, {name}));
  res.json(services[name]);
});
app.get('/service/:name/fs/*', (req, res) => {
  req.url = req.url.replace(/\/service\/.*?\/fs/, '');
  var done = finalhandler(req, res);
  var {name} = req.params, spath = path.join(SERVICEPATH, name);
  var index = serveIndex(spath), static = serveStatic(spath);
  static(req, res, (err) => err? done(err):index(req, res, done));
});
app.post('/service/:name/fs/*', async (req, res) => {
  var {name} = req.params, {file} = req.files;
  var rel = req.url.replace(/\/service\/.*?\/fs\//, '');
  var abs = path.join(SERVICEPATH, name, rel);
  await file.mv(abs);
  res.json(file.size);
});
app.post('/service/:name/run', async (req, res) => {
  var {name} = req.params, service = services[name];
  if(!service) return error.noService(res, name);
  var pname = name+'.'+dockerNames.getRandomName();
  var o = configDef(Object.assign(req.body, service));
  var cmd = await commandRun(o, pname);
  console.log({cmd});
  var {stdout, stderr} = await cpExec(cmd);
  var id = (stdout||stderr).trim();
  service.processes = service.processes||[];
  service.processes.push(id);
  var spath = path.join(SERVICEPATH, name);
  configWrite(spath, service);
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
app.post('/process/:id/exec', async (req, res) => {
  var {id} = req.params, options = req.body||{}, cmd = options.cmd||'';
  var opts = commandOptions(req.body, [], ['cmd'])
  var {stdout, stderr} = await cpExec(`docker exec ${opts} ${id} ${cmd}`);
  res.json({stdout, stderr});
});
app.get('/process/:id/export', async (req, res) => {
  var {id} = req.params;
  var stream = await docker.getContainer(id).export();
  res.writeHead(200, {'content-type': 'application/x-tar'});
  stream.pipe(res);
});
app.get('/process/:id/fs/*', (req, res) => {
  req.url = req.url.replace(/\/service\/.*?\/fs/, '');
  var done = finalhandler(req, res);
  var {name} = req.params, ppath = path.join(PROCESSPATH, name);
  var index = serveIndex(ppath), static = serveStatic(ppath);
  static(req, res, (err) => err? done(err):index(req, res, done));
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



fs.mkdirSync(SERVICEPATH, {recursive: true});
fs.mkdirSync(PROCESSPATH, {recursive: true});
configsRead(SERVICEPATH, services);
const server = http.createServer(app);
server.on('clientError', (err, soc) => {
  soc.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
server.listen(PORT, () => {
  console.log('DEVICE running on port '+PORT);
});
