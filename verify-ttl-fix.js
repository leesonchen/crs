#!/usr/bin/env node

/**
 * 24小时TTL修复验证脚本
 *
 * 使用方法：在CLI重置密码后24小时运行此脚本
 * node verify-ttl-fix.js
 */

const redis = require('./src/models/redis');

async function verifyFix() {
  console.log('🔍 TTL修复效果验证');
  console.log('='.repeat(60));
  console.log('');

  try {
    await redis.connect();
    const client = redis.getClient();

    // 检查主凭据TTL
    const adminTtl = await client.ttl('session:admin_credentials');
    const adminData = await client.hgetall('session:admin_credentials');

    console.log('📊 管理员凭据状态：');
    console.log('  用户名:', adminData.username || '未设置');
    console.log('  TTL:', adminTtl === -1 ? '✅ 永不过期' : `⚠️ ${adminTtl}秒`);
    console.log('  最后更新:', adminData.updatedAt || '未知');
    console.log('');

    // 检查备份凭据TTL
    const backupTtl = await client.ttl('session:admin_credentials_backup');
    const backupData = await client.hgetall('session:admin_credentials_backup');

    if (Object.keys(backupData).length > 0) {
      console.log('📦 备份凭据状态：');
      console.log('  用户名:', backupData.username || '未设置');
      console.log('  TTL:', backupTtl === -1 ? '✅ 永不过期' : `⚠️ ${backupTtl}秒`);
      console.log('');
    }

    // 评估结果
    console.log('🏆 评估结果：');
    if (adminTtl === -1) {
      console.log('  ✅ 修复成功！管理员凭据永远不会因TTL过期');
      console.log('  ✅ CLI重置的密码不会再24小时后失效');
    } else {
      console.log('  ❌ 修复失败！管理员凭据仍有TTL:', adminTtl, '秒');
      console.log('  ⚠️  密码可能在', Math.floor(adminTtl / 3600), '小时后失效');
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('💡 建议：定期运行此脚本验证TTL状态');

    await redis.disconnect();
    process.exit(adminTtl === -1 ? 0 : 1);

  } catch (error) {
    console.error('❌ 验证失败:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  verifyFix().catch(console.error);
}

module.exports = { verifyFix };
