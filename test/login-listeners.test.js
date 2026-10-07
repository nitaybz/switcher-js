const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Switcher = require('..')
for (const method of ['_login', '_login2', '_login3']) {
	test(`${method}: 100 successful authentications do not retain error listeners`, async t => {
		const client = new Switcher('abc123', '192.0.2.1', () => {}, false, 'v3')
		const socket = new EventEmitter()
		socket.write = () => queueMicrotask(() => socket.emit('data', Buffer.from('fef030000305a6001234567800000000', 'hex')))
		socket.destroy = () => { socket.destroyed = true; socket.emit('close') }
		socket.setMaxListeners(0)
		t.mock.method(client, '_getsocket', async () => { client.socket = socket; return socket })
		for (let i = 0; i < 100; i++) {
			client.p_session = null
			assert.equal(await client[method](), '12345678')
		}
		assert.equal(socket.listenerCount('error'), 0)
		assert.equal(socket.listenerCount('data'), 0)
		client.close()
	})
}
