const https = require('https');
const urls = [
  'https://integrate.elluciancloud.com/proxy/x-gw-get-saas-table-data?limit=1',
  'https://integrate.elluciancloud.com/proxy?resource=x-gw-get-saas-table-data&limit=1',
  'https://integrate.elluciancloud.com/api/x-gw-get-saas-table-data?limit=1',
  'https://integrate.elluciancloud.com/api/resource/x-gw-get-saas-table-data?limit=1',
  'https://integrate.elluciancloud.com/x-gw-get-saas-table-data?limit=1'
];
const doReq = (url) => new Promise((resolve) => {
  https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => resolve({ url, status: res.statusCode, body: body.slice(0, 400) }));
  }).on('error', (err) => resolve({ url, error: err.message }));
});
(async () => {
  for (const url of urls) {
    const r = await doReq(url);
    console.log('URL:', r.url);
    if (r.error) console.log('ERROR:', r.error);
    else console.log('STATUS:', r.status, 'BODY:', r.body);
    console.log('---');
  }
})();
