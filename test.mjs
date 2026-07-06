import axios from './node_modules/axios/dist/node/axios.cjs';

try {
  const r = await axios.get(`${process.env.SF_INSTANCE_URL}/services/data/v59.0/`, {
    headers: { Authorization: 'Bearer ' + process.env.SF_ACCESS_TOKEN }
  });
  console.log('Token is valid! API responded successfully.');
  console.log(JSON.stringify(r.data).slice(0, 300));
} catch(e) {
  console.log('Error status:', e.response?.status);
  console.log('Error detail:', JSON.stringify(e.response?.data));
}