import axios from 'axios';

const API_URL = 'http://localhost:3001/api';
const MOCK_TOKEN = 'mock-mobile-token';
const MOCK_USER_ID = 'test-user-id';

async function testProtectedButton() {
  try {
    console.log('1. Generating protected button...');
    const genResponse = await axios.post(`${API_URL}/payment-buttons/protected/generate`, {
      userId: MOCK_USER_ID,
      productId: 'test-product-id', // Assuming this exists or I'll mock it
      platform: 'instagram',
      isSingleUse: true
    }, {
      headers: {
        Authorization: `Bearer ${MOCK_TOKEN}`,
        'x-user-id': MOCK_USER_ID
      }
    });

    console.log('Generate Response:', genResponse.data);
    const proxyUrl = genResponse.data.proxyUrl;

    console.log('\n2. Resolving protected button...');
    // We can't easily test the redirect with axios automatically following it if it goes to Stripe
    // but we can check the status code.
    const resolveResponse = await axios.get(proxyUrl, {
      maxRedirects: 0,
      validateStatus: (status) => status === 302 || status === 403 || status === 400
    });

    console.log('Resolve Status:', resolveResponse.status);
    console.log('Resolve Location:', resolveResponse.headers.location);
  } catch (error: any) {
    console.error('Test failed:', error.response?.data || error.message);
  }
}

testProtectedButton();
