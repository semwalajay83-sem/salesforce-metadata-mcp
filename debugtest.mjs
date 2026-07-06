import axios from './node_modules/axios/dist/node/axios.cjs';

const token = process.env.SF_ACCESS_TOKEN;
const url = `${process.env.SF_INSTANCE_URL}/services/Soap/m/59.0`;

const soap = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:CallOptions><met:client>salesforce-metadata-mcp</met:client></met:CallOptions>
    <met:SessionHeader><met:sessionId>${token}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:upsertMetadata>
      <met:metadata xsi:type="met:CustomObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <met:fullName>InvoiceTest__c</met:fullName>
        <met:label>Invoice Test</met:label>
        <met:pluralLabel>Invoice Tests</met:pluralLabel>
        <met:nameField><met:label>Invoice Name</met:label><met:type>Text</met:type></met:nameField>
        <met:deploymentStatus>Deployed</met:deploymentStatus>
        <met:sharingModel>ReadWrite</met:sharingModel>
      </met:metadata>
    </met:upsertMetadata>
  </soapenv:Body>
</soapenv:Envelope>`;

try {
  const r = await axios.post(url, soap, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"upsertMetadata"' }
  });
  console.log('Success:', r.status);
  console.log(r.data.slice(0, 500));
} catch(e) {
  console.log('Error:', e.response?.status);
  console.log(e.response?.data?.slice(0, 800));
}