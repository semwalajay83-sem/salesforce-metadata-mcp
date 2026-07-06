import axios from './node_modules/axios/dist/node/axios.cjs';

const token = process.env.SF_ACCESS_TOKEN;
const url = `${process.env.SF_INSTANCE_URL}/services/Soap/m/59.0`;

const soap = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${token}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:describeMetadata>
      <met:asOfVersion>59.0</met:asOfVersion>
    </met:describeMetadata>
  </soapenv:Body>
</soapenv:Envelope>`;

try {
  const r = await axios.post(url, soap, {
    headers: { 'Content-Type': 'text/xml', 'SOAPAction': '"describeMetadata"' }
  });
  console.log('SOAP works! Status:', r.status);
} catch(e) {
  console.log('SOAP Error:', e.response?.status);
  console.log('Detail:', e.response?.data?.slice(0, 500));
}