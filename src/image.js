const Docker = require('dockerode');
const net = require('extra-net');
const cp = require('extra-cp');
const fs = require('extra-fs');
const path = require('path');
const config = require('./config');
const device = require('./device');



const ROOT = path.join(process.cwd(), '_data', 'image');
const NOOPTIONS = ['changes', 'export', 'start'];
const CONFIGFILE = 'config.json';
const DOCKERFILE = 'Dockerfile';
const BUILDLOG = 'build.log';
const COMMON = {
  version: 0,
  expose: [8000],
  from: 'python:3.7-slim',
  workdir: '/app',
};
const SPECIFIC = {
  node: {
    run: ['npm install'],
    cmd: ['npm', 'start'],
  },
  python: {
    run: [
      'if test -e requirements.txt; then pip install -r requirements.txt; fi',
      'if test -e setup.py; then python setup.py; fi'
    ],
    cmd: ['python', 'main.py'],
  },
  tensorflow: {
    workdir: '/models/model',
    expose: [8500, 8501],
    env: {'MODEL_NAME': 'model'},
  },
};
const docker = new Docker();



function defaults(value) {
  var o = Object.assign({}, COMMON, value);
  var from = o.from.replace(/\W.*/, '');
  o = Object.assign(o, SPECIFIC[from], o);
  o.ctime = o.atime = o.mtime = new Date();
  return o;
}



function findKey(object, value) {
  for(var k in object)
    if(object[k]===value) return k;
}

// from, workdir, run, expose, env, cmd
function dockerFile(options) {
  var o = options, f = '';
  f += `FROM ${o.from}\n`;
  f += `WORKDIR ${o.workdir}\n`;
  f += `COPY . ${o.workdir}\n`;
  for(var r of o.run||[])
    f += `RUN ${r}\n`;
  for(var p of o.expose||[])
    f += `EXPOSE ${p}\n`;
  for(var k in o.env||{})
    f += `ENV ${k} ${o.env[k]}\n`
  if(o.cmd) f += `CMD [${o.cmd.map(a => `"${a}"`).join(', ')}]\n`;
  return f;
}

// expose, publish
async function dockerPublish(options) {
  var o = options;
  if(!o.expose || o.expose.length===0 || o.publish) return;
  var free = await Promise.all(o.expose.map(p => net.freePort()));
  for(var i=0, I=free.length, publish={}; i<I; i++)
    publish[free[i]] = o.expose[i];
  o.publish = publish;
}

// env, publish, expose
function dockerEnv(app, instance, options) {
  var o = options, env = o.env||{};
  var expose = o.expose||[], publish = o.publish||{};
  env['PORT'] = expose.join();
  env['ADDRESS'] = expose.map(p => `${device.IP}:${findKey(publish, p)}`).join(','); // <- publish structure complex!
  env['DEVICE'] = device.ADDRESS;
  env['QUERY'] = device.QUERY;
  env['INSTANCE'] = instance;
  env['APP'] = app;
  o.env = env;
}

function dockerBuild(dir, tag, log) {
  return cp.exec(`docker build --tag=${tag} . | tee ${log}`, {cwd: dir});
}

// env, publish, restart, rm
function dockerRun(image, name, options) {
  var o = options, c = '';
  c += `docker run -itd`;
  for(var k in o.env||{})
    c += ` -e ${k}=${o.env[k]}`;
  c += ` --name ${name}`;
  for(var k in o.publish)
    c += ` -p ${k}:${o.publish[k]}`;
  if(o.restart) c += ` --restart ${o.restart}`;
  if(o.rm) c += ` --rm`;
  if(o.workdir) c += ` -w ${o.workdir}`;
  c += ` ${image}`;
  return c;
}

function lsMap(options) {
  var o = options;
  return {
    id: (o.RepoTags[0]||'').replace(/\:.*/, '')||o.Id, 
    size: o.Size, tags: o.RepoTags
  };
}

const inspectMap = lsMap;
function inspect(id) {
  return docker.getImage(id).inspect().then(inspectMap);
}



async function ls(options) {
  // NOTE: config.read() changed, this needs to be fixed
  var ids = await fs.readdir(ROOT), imap = new Map();
  var imgs = (await docker.listImages(options)).map(lsMap);
  imgs.forEach(i => imap.set(i.id, i));
  var _ls = ids.map(id => config.read(path.join(ROOT, id, CONFIGFILE)).then(v => Object.assign(v, imap.get(id))));
  return await Promise.all(_ls);
}

async function build(id, dir, options) {
  var o = defaults(options);
  var df = path.join(dir, DOCKERFILE);
  await fs.writeFile(df, dockerFile(o));
  var app = path.join(ROOT, id);
  if(!fs.existsSync(app)) await fs.mkdirp(app);
  await config.write(path.join(app, CONFIGFILE), o);
  return dockerBuild(dir, id, path.join(app, BUILDLOG));
}

async function run(id, name, options) {
  var file = path.join(ROOT, id, CONFIGFILE);
  // should use global status here
  var o = Object.assign(await config.read(file), options);
  await dockerPublish(o);
  dockerEnv(id, name, o);
  return cp.exec(dockerRun(id, name, o));
}

async function remove(id, options) {
  await command(id, 'stop', false, options);
  await command(id, 'remove', true, options);
  await docker.getImage(id).remove(options);
  return fs.remove(path.join(ROOT, id));
}

function status(id, prev, state) {
  var file = path.join(ROOT, id, CONFIGFILE);
  return Promise.all([prev||{}, config.read(file), state||inspect(id)]).then(
    vs => Object.assign.apply(null, vs)
  );
}

function setStatus(id, value) {
  var file = path.join(ROOT, id, CONFIGFILE);
  return config.write(file, value);
}

function logs(id) {
  var log = path.join(ROOT, id, BUILDLOG);
  return fs.readFile(log, 'utf8').catch(err => {
    if(fs.existsSync(path.join(ROOT, id))) return '';
    throw err;
  });
}

// container commands
async function command(id, action, all, options) {
  var cs = await docker.listContainers({ancestor: id, all});
  return Promise.all(cs.map(c => {
    options = NOOPTIONS.includes(action)? undefined:options;
    return docker.getContainer(c.Id)[action](options);
  }));
}
exports.ls = ls;
exports.build = build;
exports.run = run;
exports.remove = remove;
exports.status = status;
exports.setStatus = setStatus;
exports.logs = logs;
exports.command = command;
fs.mkdirpSync(ROOT);
