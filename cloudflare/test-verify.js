import { verifyKey } from 'discord-interactions';

const signature = 'bad';
const timestamp = 'bad';
const body = '{"type":1}';
const pubKey = 'f55c39171558027ff87fa217210647fd2c8ca87806080456538f8b4414fe59c0';

try {
  const result = verifyKey(body, signature, timestamp, pubKey);
  console.log("verifyKey Result:", result);
} catch (e) {
  console.log("verifyKey threw exception:", e.message);
}
