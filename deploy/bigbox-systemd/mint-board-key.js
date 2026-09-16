const crypto = require('crypto');
const token = `pcp_board_${crypto.randomBytes(24).toString('hex')}`;
const keyHash = crypto.createHash('sha256').update(token).digest('hex');
console.log(token);
console.error(keyHash);
