import { AwsV4Signer } from 'aws4fetch';
async function test() {
  const accountId = "546d8ced92767f9c8c2697640c001577";
  const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/discord-connector-uploads/test.txt`);
  const signer = new AwsV4Signer({
      url: url.toString(),
      accessKeyId: "4eb6fc7e0352d340d9205c240e87e4f1",
      secretAccessKey: "7b6ad9985ae13c3c0652debf8c124a78c4dfdab1b4893f98cacb89a652ebdd26",
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      service: 's3',
      region: 'auto',
      signQuery: true,
      expiresIn: 3600,
  });
  const signed = await signer.sign();
  console.log(signed.url);
}
test();
