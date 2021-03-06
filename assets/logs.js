const $h2 = document.querySelector('h2');
const $p = document.querySelector('p');
const $clear = document.querySelector('#clear');
const $stdout = document.querySelector('#stdout');
const $stderr = document.querySelector('#stderr');
const ansi_up = new AnsiUp();
var options = {};



function searchParse(search) {
  var search = search.substring(1);
  return search? JSON.parse('{"' + decodeURI(search).replace(/"/g, '\\"')
  .replace(/&/g, '","').replace(/=/g,'":"') + '"}'):{};
}

function onReady() {
  var o = searchParse(location.search);
  console.log('onReady()', o);
  document.body.className = o.image? 'image':'container';
  m.render($h2, [o.image||o.container, m('div', m('small', o.from||''))]);
  return Object.assign(o, {stdout: 0, stderr: 0, p:0});;
}

function render(err, stdout, stderr, o) {
  var p = err? err.message||'':'';
  var ol = stdout.length, el = stderr.length, pl = p.length;
  if(ol===o.stdout && el===o.stderr && pl===o.p) return;
  console.log('render()', {ol, el, pl}, o);
  o.stdout = ol; o.stderr = el; o.p = pl;
  $stdout.innerHTML = ansi_up.ansi_to_html(stdout);
  $stderr.innerHTML = ansi_up.ansi_to_html(stderr);
  $p.innerHTML = ansi_up.ansi_to_html(err? err.message:'');
}

function request(o) {
  console.log('request()', o);
  var typ = o.image? 'image':'container';
  var url = `/${typ}/${o.image||o.container}/logs`;
  var pout = m.request({method: 'GET', url: url+'?stdout=1'});
  var perr = m.request({method: 'GET', url: url+'?stderr=1'});
  Promise.all([pout, perr]).then(
    ([stdout, stderr]) => render(null, stdout||'', stderr||'', o),
    (err) => render(err, '', err.message||'', o));
}



options = onReady();
request(options);
setInterval(() => request(options), 1000);
