const EventEmitter = require('events');
class WS extends EventEmitter { constructor() { super(); setTimeout(() => this.emit('error', new Error('ws stub')), 10); } send() {} close() {} }
module.exports = WS;
