import uuid
import json
import os
from pathlib import Path
import urllib.request

file_path = Path('test_report.lis')
if not file_path.exists():
    raise SystemExit('test_report.lis not found')

boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
headers = {
    'Content-Type': f'multipart/form-data; boundary={boundary}'
}

body = []

def add_field(name, value):
    body.append(f'--{boundary}')
    body.append(f'Content-Disposition: form-data; name="{name}"')
    body.append('')
    body.append(value)


def add_file(name, filename, data):
    body.append(f'--{boundary}')
    body.append(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"')
    body.append('Content-Type: application/octet-stream')
    body.append('')
    body.append(data)

add_file('file', file_path.name, file_path.read_bytes().decode('latin-1'))
add_field('formData', json.dumps({'ReportType':'Both','PrintLogicFile':'Y'}))
body.append(f'--{boundary}--')
body.append('')

body_bytes = '\r\n'.join(body).encode('latin-1')
req = urllib.request.Request('http://localhost:3002/api/run-lis', data=body_bytes, headers=headers)
with urllib.request.urlopen(req, timeout=30) as res:
    print(res.read().decode('utf-8'))
