import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
  console.log('Testing Gemini 1.5 Flash...');
  try {
    const model = new ChatGoogleGenerativeAI({
      model: 'gemini-1.5-flash',
      apiKey: process.env.GOOGLE_API_KEY,
    });
    const res = await model.invoke('Hello, are you there?');
    console.log('Response:', res.content);
  } catch (err) {
    console.error('Failed with default (v1beta):', err.message);
    
    console.log('Testing with apiVersion: v1...');
    try {
        const modelV1 = new ChatGoogleGenerativeAI({
            model: 'gemini-1.5-flash',
            apiKey: process.env.GOOGLE_API_KEY,
            apiVersion: 'v1',
        });
        const resV1 = await modelV1.invoke('Hello, are you there?');
        console.log('Response V1:', resV1.content);
    } catch (err2) {
        console.error('Failed with v1:', err2.message);
    }
  }
}

test();
