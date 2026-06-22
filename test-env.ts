import dotenv from 'dotenv';
dotenv.config();
console.log('NO_REDIS:', process.env.NO_REDIS);
console.log('PORT:', process.env.PORT);
