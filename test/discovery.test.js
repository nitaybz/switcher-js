const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const dgram = require('node:dgram')
const Switcher = require('..')

function sockets(t) {
	const created = [], active = new Set()
	t.mock.method(dgram, 'createSocket', (type, handler) => {
		const socket = new EventEmitter()
		socket.on('message', handler)
		socket.bind = () => { active.add(socket) }
		socket.close = callback => {
			if (!active.delete(socket)) throw Object.assign(new Error('not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' })
			queueMicrotask(() => { socket.emit('close'); if (callback) callback() })
		}
		created.push(socket)
		return socket
	})
	return { created, active }
}
test('one UDP error releases all four sockets and reports only one failure', async t => {
	const env = sockets(t)
	const proxy = Switcher.listen(() => {})
	let errors = 0
	proxy.on('error', () => errors++)
	env.created[0].emit('error', new Error('offline'))
	await Promise.resolve()
	assert.equal(env.active.size, 0)
	assert.equal(errors, 1)
	await proxy.close()
})
test('close tolerates an already closed socket and can be called twice', async t => {
	const env = sockets(t)
	const proxy = Switcher.listen(() => {})
	env.created[0].close()
	await proxy.close()
	await proxy.close()
	assert.equal(env.active.size, 0)
})
test('100 failed listener lifecycles never retain UDP resources', async t => {
	const env = sockets(t)
	for (let i = 0; i < 100; i++) {
		const proxy = Switcher.listen(() => {})
		proxy.on('error', () => {})
		assert.equal(env.active.size, 4)
		env.created.at(-1).emit('error', new Error('offline'))
		await proxy.close()
		assert.equal(env.active.size, 0)
	}
})
test('device close releases TCP/status references and is idempotent', t => {
	const env = sockets(t)
	const client = new Switcher('abc123', '192.0.2.1', () => {}, false, 'v3')
	client.socket = { destroyed: false, destroy() { this.destroyed = true } }
	client.status_socket = dgram.createSocket('udp4', () => {})
	client.status_socket.bind()
	client.close()
	assert.equal(client.socket, null)
	assert.equal(client.status_socket, null)
	assert.doesNotThrow(() => client.close())
	assert.equal(env.active.size, 0)
})
test('concurrent TCP connection requests share one pending socket', async t => {
	const client = new Switcher('abc123', '192.0.2.1', () => {}, false, 'v3')
	const socket = new EventEmitter()
	socket.destroy = () => { socket.destroyed = true }
	let connections = 0, ready
	t.mock.method(client, '_connect', () => { connections++; return new Promise(resolve => { ready = resolve }) })
	const first = client._getsocket(), second = client._getsocket()
	assert.equal(connections, 1)
	ready(socket)
	assert.equal(await first, await second)
	client.close()
})
test('a connection that finishes after close is destroyed and cannot be reused', async t => {
	const client = new Switcher('abc123', '192.0.2.1', () => {}, false, 'v3')
	const socket = new EventEmitter()
	socket.destroy = () => { socket.destroyed = true }
	let ready
	t.mock.method(client, '_connect', () => new Promise(resolve => { ready = resolve }))
	const pending = client._getsocket()
	client.close()
	ready(socket)
	await assert.rejects(pending)
	assert.equal(socket.destroyed, true)
	assert.equal(client.socket, null)
	await assert.rejects(client._getsocket())
})
