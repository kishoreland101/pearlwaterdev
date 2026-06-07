const fs = require('fs');
const { FormData } = require('undici');
const form = new FormData();
form.set('file', fs.createReadStream('test_report.lis'));
form.set('formData', JSON.stringify({ ReportType: 'Both', PrintLogicFile: 'Y' }));

fetch('http://localhost:3003/api/run-lis', { method: 'POST', body: form })
  .then(res => res.text())
  .then(body => {
    console.log(body);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
