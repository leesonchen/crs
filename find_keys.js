const redis = require('./src/models/redis');

async function findActiveKeys() {
  try {
    const keys = await redis.keys('apikey:*');

    for (const key of keys) {
      if (key === 'apikey:hash_map') continue;

      const keyData = await redis.getApiKey(key.replace('apikey:', ''));
      if (keyData && keyData.isDeleted !== 'true') {
        console.log(`=== Key ID: ${keyData.id} ===`);
        console.log(`Name: ${keyData.name}`);
        console.log(`API Key Hash: ${keyData.apiKey}`);
        console.log(`Active: ${keyData.isActive}`);
        console.log(`Permissions: ${keyData.permissions}`);
        console.log('');
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

findActiveKeys();