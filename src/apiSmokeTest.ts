import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function runApiSmokeTest() {
  console.log("Starting API Smoke Test...");

  const testUserId = "test-user-api-" + Date.now();
  const PORT = process.env.PORT || 3000;
  const API_URL = `http://localhost:${PORT}/api/analytics/strategies`;

  try {
    console.log(`Calling API: ${API_URL}`);
    // We use default-user or similar if we want it to work without complex auth setup in smoke test
    // But mobileAuth might require a token or at least the header
    const response = await axios.get(API_URL, {
      headers: {
        'x-user-id': testUserId
      }
    });

    console.log("Response status:", response.status);
    console.log("Response data:", JSON.stringify(response.data, null, 2));

    if (response.status === 200 && Array.isArray(response.data)) {
      console.log("API Smoke Test Passed!");
    } else {
      console.error("API Smoke Test Failed: Unexpected response format.");
    }
  } catch (error: any) {
    console.error("API Smoke Test Failed:", error.response?.data || error.message);
  }
}

runApiSmokeTest();
