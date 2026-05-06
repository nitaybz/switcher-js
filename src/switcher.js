/* eslint-disable no-async-promise-executor */
"use strict";
const { he } = require('./tok');
const net = require('net');
const dgram = require('dgram');
const struct = require('python-struct');
const EventEmitter = require('events').EventEmitter;
var AdmZip = require("adm-zip");
var zip = new AdmZip(__dirname + "/t.zip");

const crc16ccitt = require('./crc').crc16ccitt;
const SwitcherUDPMessage = require('./udp')

const P_SESSION = '00000000';
const P_KEY = '00000000000000000000000000000000';

const STATUS_EVENT = 'status';
const MESSAGE_EVENT = 'message'
const READY_EVENT = 'ready';
const ERROR_EVENT = 'error';
const STATE_CHANGED_EVENT = 'state';
const DURATION_CHANGED_EVENT = 'duration';
const BREEZE_CAPABILITIES_EVENT = 'capabilities'


const SWITCHER_UDP_IP = "0.0.0.0";
const SWITCHER_UDP_PORT = 20002;
const SWITCHER_UDP_PORT2 = 20003;
const SWITCHER_UDP_PORT3 = 10002;
const SWITCHER_UDP_PORT4 = 10003;

const LISTENING_PORTS = [SWITCHER_UDP_PORT, SWITCHER_UDP_PORT2, SWITCHER_UDP_PORT3, SWITCHER_UDP_PORT4]

const SWITCHER_TCP_PORT = 9957;
const SWITCHER_TCP_PORT2 = 10000;
const OLD_TCP_GROUP = ['power_plug', 'v2_qca', 'v2_esp', 'v3', 'v4', 'mini', 'on_wall'];

const OFF = 0;
const ON = 1;


const SEPARATED_SWING_REMOTES = [
	"ELEC7022",
	"ZM079055",
	"ZM079065",
	"ZM079049",
	"ZM079065",
]

const breeze_dictionary = {
	modes: {
		'aa': 'AUTO',
		'ad': 'DRY',
		'aw': 'FAN',
		'ar': 'COOL',
		'ah': 'HEAT'

	},
	fan_levels: {
		'f0': 'AUTO',
		'f1': 'LOW',
		'f2': 'MEDIUM',
		'f3': 'HIGH',
	}
}
class ConnectionError extends Error {
	constructor(ip, port) {
		super(`connection error: failed to connect to switcher on ip: ${ip}:${port}. please make sure it is turned on and available.`);
		this.ip = ip;
		this.port = port;
	}
}


class Switcher extends EventEmitter {
	constructor(device_id, switcher_ip, log, listen, device_type, remote, token, key) {
		super();
		this.device_id = device_id;
		this.switcher_ip = switcher_ip;
		this.device_key = key;
		this.device_type = device_type || 'unknown';
		this.phone_id = '0000';
		if (token)
			this.token = he(token);
		this.device_pass = '00000000';
		this.newType = !OLD_TCP_GROUP.includes(device_type)
		this.isBreeze = device_type && device_type === 'breeze'
		this.SWITCHER_PORT = this.newType ? SWITCHER_TCP_PORT2 : SWITCHER_TCP_PORT;
		this.log = log;
		this.p_session = null;
		this.socket = null;
		if (listen)
			this.status_socket = this._hijack_status_report();
		if (device_type === 'breeze')
			this._get_breeze_remote(remote)
				.then(remote => this.breeze_remote = remote)
	}

	static discover(log, identifier, discovery_timeout) {
		var proxy = new EventEmitter.EventEmitter();
		var timeout = null
		const sockets = []

		LISTENING_PORTS.forEach(switcher_port => {
			var socket = dgram.createSocket('udp4', (raw_msg, rinfo) => {
				var ipaddr = rinfo.address;
				if (!SwitcherUDPMessage.is_valid(raw_msg)) {
					return; // ignoring - not a switcher broadcast message
				}
				var udp_message = new SwitcherUDPMessage(raw_msg);
				var device_id = udp_message.extract_device_id();
				var device_name = udp_message.extract_device_name();
				var device_type = udp_message.extract_type();
				var device_key = udp_message.extract_device_key();
				if (device_type === 'breeze')
					var remote = udp_message.extract_remote();
				if (identifier && identifier !== device_id && identifier !== device_name && identifier !== ipaddr) {
					log(`Found ${device_name} (${ipaddr}) - Not the device we're looking for!`);
					return;
				}

				// log(`Found ${device_name} (${ipaddr})!`);
				proxy.emit(READY_EVENT, new Switcher(device_id, ipaddr, log, false, device_type, remote, device_key));
				clearTimeout(timeout);
				socket.close();
				socket = null;

			});
			socket.on('error', (error) => {
				proxy.emit(ERROR_EVENT, error);
				clearTimeout(timeout);
				socket.close();
				socket = null;
			});
			socket.bind(switcher_port, SWITCHER_UDP_IP);
			sockets.push(socket)

		})

		if (discovery_timeout) {
			timeout = setTimeout(() => {
				log(`stopping discovery, closing sockets`);
				sockets.forEach(socket => {
					socket.close();
					socket = null;
				})
			}, discovery_timeout * 1000);
		}

		proxy.close = () => {
			log('closing discover socket');
			sockets.forEach(socket => {
				socket.close();
			})
		}
		return proxy;
	}

	static listen(log, identifier) {
		var proxy = new EventEmitter.EventEmitter();

		const sockets = []

		LISTENING_PORTS.forEach(switcher_port => {
			var socket = dgram.createSocket('udp4', (raw_msg, rinfo) => {
				var ipaddr = rinfo.address;
				if (!SwitcherUDPMessage.is_valid(raw_msg)) {
					return; // ignoring - not a switcher broadcast message
				}
				var udp_message = new SwitcherUDPMessage(raw_msg);
				var device_id = udp_message.extract_device_id();
				var device_name = udp_message.extract_device_name();
				if (identifier && identifier !== device_id && identifier !== device_name && identifier !== ipaddr) {
					log(`Found ${device_name} (${ipaddr}) - Not the device we're looking for!`);
					return;
				}

				var device_type = udp_message.extract_type();
				if (['power_plug', 'v2_qca', 'v2_esp', 'v3', 'v4', 'mini', 'on_wall'].includes(device_type)) {
					proxy.emit(MESSAGE_EVENT, {
						device_id: device_id,
						device_ip: ipaddr,
						name: device_name,
						device_key: udp_message.extract_device_key(),
						type: udp_message.extract_type(),
						state: {
							power: udp_message.extract_switch_state(),
							remaining_seconds: udp_message.extract_shutdown_remaining_seconds(),
							default_shutdown_seconds: udp_message.extract_default_shutdown_seconds(),
							power_consumption: udp_message.extract_power_consumption()
						}
					});
				} else if (device_type === 'breeze') {
					proxy.emit(MESSAGE_EVENT, {
						device_id: device_id,
						device_ip: ipaddr,
						name: device_name,
						remote: udp_message.extract_remote(),
						type: device_type,
						state: {
							power: udp_message.extract_ac_power(),
							current_temp: udp_message.extract_current_temp(),
							target_temp: udp_message.extract_target_temp(),
							mode: udp_message.extract_ac_mode(),
							fan_level: udp_message.extract_fan_level(),
							swing: udp_message.extract_swing()
						}
					})
				}
				else if (device_type.includes('runner'))
					proxy.emit(MESSAGE_EVENT, {
						device_id: device_id,
						device_ip: ipaddr,
						name: device_name,
						type: device_type,
						state: {
							position: udp_message.extract_position(),
							direction: udp_message.extract_direction(),
							child_lock: udp_message.extract_child_lock()
						}
					});

				else if (device_type === 's11')
					proxy.emit(MESSAGE_EVENT, {
						device_id: device_id,
						device_ip: ipaddr,
						name: device_name,
						type: device_type,
						state: {
							light1_power: udp_message.extract_light(1),
							light2_power: udp_message.extract_light(2),
							runner3_position: udp_message.extract_position(3),
							runner3_direction: udp_message.extract_direction(3),
							runner3_child_lock: udp_message.extract_child_lock(3)
						}
					});

				else if (device_type === 's12')
					proxy.emit(MESSAGE_EVENT, {
						device_id: device_id,
						device_ip: ipaddr,
						name: device_name,
						type: device_type,
						state: {
							light1_power: udp_message.extract_light(1),
							runner2_position: udp_message.extract_position(2),
							runner2_direction: udp_message.extract_direction(2),
							runner2_child_lock: udp_message.extract_child_lock(2),
							runner3_position: udp_message.extract_position(3),
							runner3_direction: udp_message.extract_direction(3),
							runner3_child_lock: udp_message.extract_child_lock(3)
						}
					});

				else if (/^sl(mini)?0\d$/.test(device_type)) {
					const light_status = {
						device_id: device_id,
						device_ip: ipaddr,
						name: device_name,
						type: device_type,
						state: {
							light1_power: udp_message.extract_light(1)
						}
					}
					if (parseInt(device_type.replace(/\D/g, '')) > 1)
						light_status.state.light2_power = udp_message.extract_light(2)
					if (parseInt(device_type.replace(/\D/g, '')) > 2)
						light_status.state.light3_power = udp_message.extract_light(3)
					proxy.emit(MESSAGE_EVENT, light_status);
				}

				else
					proxy.emit(MESSAGE_EVENT, {
						device_id: device_id,
						device_ip: ipaddr,
						name: device_name,
						type: device_type,
						data_hex: udp_message.data_hex,
						data_str: udp_message.data_str
					});

			})

			socket.on('error', (error) => {
				proxy.emit(ERROR_EVENT, error);
				socket.close();
				socket = null;
			});
			socket.bind(switcher_port, SWITCHER_UDP_IP);
			sockets.push(socket)
		})

		proxy.close = () => {
			log('closing listen socket');
			sockets.forEach(socket => {
				socket.close();
			})
		}
		return proxy;
	}

	update_device_key(key) {
		this.log('device key updated with', key)
		this.device_key = key
	}

	turn_off() {
		var off_command = OFF + '00' + '00000000';
		this._run_power_command(off_command);
	}

	turn_on(duration = 0) {
		var on_command = ON + '00' + this._timer_value(duration);
		this._run_power_command(on_command);
	}

	stop_runner(index = 0) {
		this.log(`Sending stop command`)
		let command = '0000'
		command = index ? `0${index}` + command : command
		this._run_general_command(command, '3702');
	}

	set_child_lock(lock = false, index = 0) {
		this.log(`Sending child lock command: ${lock}`)
		let command = lock ? '01' : '00'
		command = index ? `0${index}` + command : command
		this._run_general_command(command, '3707');
	}

	set_light(power = false, index = 0) {
		this.log(`Sending light power command: ${power}`)
		let command = power ? '01' : '00'
		command = index ? `0${index}` + command : command
		this._run_general_command(command, '370a');
	}

	set_position(pos = 0, index = 0) {
		this.log(`Sending position command: ${pos}%`)
		let command = this._get_hex_pos(pos)
		command = index ? `0${index}` + command : command
		this._run_general_command(command);
	}


	is_breeze_on() {
		return this.status()
			.then(status => {
				return status.power === 'ON'
			})
	}

	set_separated_swing_command(state) {
		const key = state ? 'FUN_d1' : 'FUN_d0'

		this.log(`sending separated swing command: ${JSON.stringify(state)} (${key})`)

		// find command in IRWaveList
		const IRCommand = this.remote_set.IRWaveList.find(wave => wave.Key === key)

		if (!IRCommand) {
			this.log(`ERROR: Wrong IR Command (${key})! Can't send separated swing command !!!`)
			return
		}
		let command = `${IRCommand.Para}|${IRCommand.HexCode}`
		command = "00000000" + this._ascii_to_hex(command)
		this._run_general_command(command);
	}

	set_breeze_command(state) {
		this.is_breeze_on()
			.then(isOn => {
				if (state.power === 'OFF' && !isOn) {
					// Do nothing
					this.log('already off')
					return null
				}
				let command = ''
				let IRCommand, commandKey
				if (state.power === 'OFF' && isOn) {
					// turn OFF
					this.log('turning off breeze')
					commandKey = 'off'
				} else if (state.power === 'ON' && !isOn && this.remote_set.OnOffType) {
					// turn ON and set command
					this.log('sending on command with state:' + JSON.stringify(state))
					commandKey = 'on_' + this._get_breeze_command_key(state)
				} else {
					// only set command
					this.log('sending change state command:' + JSON.stringify(state))
					commandKey = this._get_breeze_command_key(state)
				}

				// find command in IRWaveList
				IRCommand = this.remote_set.IRWaveList.find(wave => wave.Key === commandKey)

				// if not found, find similar command that includes some of the params (e.g "on_ad" instead of "on_ad_f0")
				if (!IRCommand)
					IRCommand = this.remote_set.IRWaveList.find(wave => commandKey.includes(wave.Key))

				if (!IRCommand) {
					this.log(`ERROR: Wrong IR Command (${commandKey})! Can't send command !!!`)
					return
				}
				command = `${IRCommand.Para}|${IRCommand.HexCode}`
				command = "00000000" + this._ascii_to_hex(command)
				this._run_general_command(command);

				if (this.breeze_remote.separated_swing && state.swing === 'ON') {
					setTimeout(this.set_separated_swing_command, 1000, true)
				}

			})
	}

	async set_default_shutdown(duration = 3600) {
		var auto_close = this._set_default_shutdown(duration)
		let p_session = await this._login();
		let data = "fef05b0002320102" + p_session + "340001000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id +
			"00" + this.phone_id + "0000" + this.device_pass + "00000000000000000000000000000000000000000000000000000000040400" + auto_close;
		data = this._crc_sign_full_packet_com_key(data, P_KEY);
		this.log(`sending default_shutdown command | ${duration} seconds`);
		var socket = await this._getsocket();
		socket.write(Buffer.from(data, 'hex'));
		socket.once('data', () => {
			this.emit(DURATION_CHANGED_EVENT, duration); // todo: add old state and new state
		});

	}

	async status() {  // refactor
		return new Promise(async (resolve, reject) => {
			let data, p_session
			if (this.newType) {
				p_session = await this._login2();
				data = "fef0300003050103" + p_session + "390001000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id + "00"
			} else {
				p_session = await this._login();
				data = "fef0300002320103" + p_session + "340001000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id + "00";
			}
			data = this._crc_sign_full_packet_com_key(data, P_KEY);
			var socket = await this._getsocket();
			socket.write(Buffer.from(data, 'hex'));
			socket.once('data', (data) => {
				try {
					// var device_name = data.toString().substr(40, 32).replace(/\0/g, '');
					if (this.isBreeze) {
						const data_hex = data.toString('hex')
						const state = {
							device_id: this.device_id,
							remote: data.toString().substr(84, 8).replace(/\0/g, ''),
							current_temp: parseInt(data_hex.substr(154, 2) + data_hex.substr(152, 2), 16) / 10,
							power: data_hex.substr(156, 2) == '00' ? 'OFF' : 'ON',
							target_temp: parseInt(data_hex.substr(160, 2), 16),
							mode: SwitcherUDPMessage.get_breeze_mode(data_hex.substr(158, 2)),
							fan_level: SwitcherUDPMessage.get_breeze_fan_level(data_hex.substr(162, 1)),
							swing: data_hex.substr(162, 1) == '0' ? 'OFF' : 'ON'
						}
						resolve(state);
					} else {
						var state_hex = data.toString('hex').substr(150, 4);
						var state = state_hex == '0000' ? OFF : ON;
						var b = data.toString('hex').substr(178, 8);
						var remaining_seconds = parseInt(b.substr(6, 2) + b.substr(4, 2) + b.substr(2, 2) + b.substr(0, 2), 16);
						b = data.toString('hex').substr(194, 8);
						var default_shutdown_seconds = parseInt(b.substr(6, 2) + b.substr(4, 2) + b.substr(2, 2) + b.substr(0, 2), 16);
						b = data.toString('hex').substr(154, 4);
						var power_consumption = parseInt(b.substr(2, 2) + b.substr(0, 2), 16);
						resolve({
							device_id: this.device_id,
							power: state,
							remaining_seconds: remaining_seconds,
							default_shutdown_seconds: default_shutdown_seconds,
							power_consumption: power_consumption
						});
					}
				} catch (error) {
					this.log('connection rejected, error:', error)
					reject(error);
				}
			});
		})
	}

	close() {
		if (this.socket && !this.socket.destroyed) {
			this.log('closing sockets');
			this.socket.destroy();
			this.log('main socket is closed');
		}
		if (this.status_socket && !this.status_socket.destroyed) {
			this.log('closing sockets');
			this.status_socket.close();
			this.log('status socket is closed');
		}
	}

	async _getsocket() {
		if (this.socket && !this.socket.destroyed) {
			return await this.socket;
		}
		try {
			var socket = await this._connect(this.SWITCHER_PORT, this.switcher_ip);
			socket.on('error', (error) => {
				this.log('global error event:', error);
			});
			socket.on('close', (had_error) => {
				this.log('global close event:', had_error);
			});
			this.socket = socket;
			return socket;
		}
		catch (error) {
			this.socket = null;
			this.emit(ERROR_EVENT, new ConnectionError(this.switcher_ip, this.SWITCHER_PORT));
			throw error;
		}
	}

	_connect(port, ip) {
		return new Promise((resolve, reject) => {
			var socket = net.connect(port, ip);
			socket.setKeepAlive(true);
			socket.once('ready', () => {
				this.log('successful connection, socket was created');
				resolve(socket);
			});
			socket.once('close', (had_error) => {
				this.log('connection closed, had error:', had_error)
				reject(had_error);
			});
			socket.once('error', (error) => {
				this.log('connection rejected, error:', error)
				reject(error);
			});
		});
	}

	_hijack_status_report() {
		var socket = dgram.createSocket('udp4', (raw_msg, /* rinfo */) => {
			if (!SwitcherUDPMessage.is_valid(raw_msg)) {
				return; // ignoring - not a switcher broadcast message
			}
			// var ipaddr = rinfo.address;
			var udp_message = new SwitcherUDPMessage(raw_msg);

			var device_id = udp_message.extract_device_id()
			if (device_id === this.device_id) {
				if (!this.newType)
					this.emit(STATUS_EVENT, {
						device_key: udp_message.extract_device_key(),
						power: udp_message.extract_switch_state(),
						remaining_seconds: udp_message.extract_shutdown_remaining_seconds(),
						default_shutdown_seconds: udp_message.extract_default_shutdown_seconds(),
						power_consumption: udp_message.extract_power_consumption()
					})
				else if (this.isBreeze)
					this.emit(STATUS_EVENT, {
						power: udp_message.extract_ac_power(),
						current_temp: udp_message.extract_current_temp(),
						target_temp: udp_message.extract_target_temp(),
						mode: udp_message.extract_ac_mode(),
						fan_level: udp_message.extract_fan_level(),
						swing: udp_message.extract_swing()
					})
				else if (this.device_type === 's11')
					this.emit(STATUS_EVENT, {
						light1_power: udp_message.extract_light(1),
						light2_power: udp_message.extract_light(2),
						runner3_position: udp_message.extract_position(3),
						runner3_direction: udp_message.extract_direction(3),
						runner3_child_lock: udp_message.extract_child_lock(3)
					});

				else if (this.device_type === 's12')
					this.emit(STATUS_EVENT, {
						light1_power: udp_message.extract_light(1),
						runner2_position: udp_message.extract_position(2),
						runner2_direction: udp_message.extract_direction(2),
						runner2_child_lock: udp_message.extract_child_lock(2),
						runner3_position: udp_message.extract_position(3),
						runner3_direction: udp_message.extract_direction(3),
						runner3_child_lock: udp_message.extract_child_lock(3)
					});

				else if (/^sl(mini)?0\d$/.test(this.device_type)) {
					const light_status = {
						light1_power: udp_message.extract_light(1)
					}
					if (parseInt(this.device_type.replace(/\D/g, '')) > 1)
						light_status.light2_power = udp_message.extract_light(2)
					if (parseInt(this.device_type.replace(/\D/g, '')) > 2)
						light_status.light3_power = udp_message.extract_light(3)
					this.emit(STATUS_EVENT, light_status);
				}

				else // if (device_type.includes('runner'))
					this.emit(STATUS_EVENT, {
						position: udp_message.extract_position(),
						direction: udp_message.extract_direction(),
						child_lock: udp_message.extract_child_lock()
					})
			}
		});
		socket.on('error', (error) => {
			this.emit(ERROR_EVENT, new Error("status report failed. error: " + error.message)); // hoping this will keep the original stack trace
		});
		socket.bind((!this.newType ? SWITCHER_UDP_PORT : SWITCHER_UDP_PORT2), SWITCHER_UDP_IP);
		return socket;
	}

	async _get_breeze_remote(remote) {
		try {
			this.remote_set = await this._get_remote_set(remote)
		} catch (err) {
			this.log(`Can't get remote set for ${remote} !`)
			this.log(err.message || err.stack || err)
			return
		}

		const capabilities = {
			remote,
			modes: [],
			fan_levels: [],
			swing: false,
			min_temp: 100,
			max_temp: 0
		}

		if (!this.remote_set.IRWaveList || !this.remote_set.IRWaveList.length) {
			this.log(`Wrong Remote, can't find commands!`)
			this.log('Remote Set:')
			this.log(this.remote_set)
			return
		}

		for (const wave of this.remote_set.IRWaveList) {
			const key = wave.Key
			// add modes
			const newMode = breeze_dictionary.modes[key.substr(0, 2)]
			if (newMode && !capabilities.modes.includes(newMode))
				capabilities.modes.push(newMode)

			// add fan levels
			const newFanLevel = key.match(/f\d/) ? breeze_dictionary.fan_levels[key.match(/f\d/)[0]] : null
			if (newFanLevel && !capabilities.fan_levels.includes(newFanLevel))
				capabilities.fan_levels.push(newFanLevel)

			// add min/max temperatures
			const newTemp = key.substr(2, 2) ? parseInt(key.substr(2, 2)) : null
			if (newTemp && newTemp > capabilities.max_temp)
				capabilities.max_temp = newTemp
			if (newTemp && newTemp < capabilities.min_temp)
				capabilities.min_temp = newTemp

			// swing
			const swingAvailable = key.match(/d1/)
			if (swingAvailable)
				capabilities.swing = true

			if (SEPARATED_SWING_REMOTES.includes(remote)) {
				capabilities.swing = true
				capabilities.separated_swing = true
			}
		}

		this.emit(BREEZE_CAPABILITIES_EVENT, capabilities)
		this.log('remote capabilities:' + JSON.stringify(capabilities))
		return capabilities
	}

	async _get_remote_set(remote) {
		return new Promise(async (resolve, reject) => {

			const zipEntry = zip.getEntries()[0]
			let IRWaves = zipEntry.getData().toString("utf8")
			IRWaves = JSON.parse(IRWaves)

			const remote_waves = IRWaves.find(remote_set => remote_set.IRSetID === remote)
			if (remote_waves)
				resolve(remote_waves)
			else
				reject(new Error(`Can't find remote ${remote}`))
		})
	}

	async _login() {
		if (this.p_session) return this.p_session;
		try {
			this.p_session = await new Promise(async (resolve, reject) => {
				let data = "fef052000232a100" + P_SESSION + "340001000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_key + "00" +
					this.phone_id + "0000" + this.device_pass + "00000000000000000000000000000000000000000000000000000000";
				data = this._crc_sign_full_packet_com_key(data, P_KEY);
				this.log("login...");
				try {
					var socket = await this._getsocket();
				} catch (err) {
					reject(err)
					return
				}
				this.log('sending data')
				this.log(data)
				socket.write(Buffer.from(data, 'hex'));
				socket.once('data', (data) => {
					var result_session = data.toString('hex').substr(16, 8)
					this.log('received login data:')
					this.log(data.toString('hex'))
					// todo: make sure result_session exists
					this.log('received session id: ' + result_session);
					resolve(result_session); // returning _p_session after a successful login
				});
				this.socket.once('error', (error) => {
					reject(error);
				});
			});
		}
		catch (error) {
			this.log('login failed due to an error', error);
			this.emit(ERROR_EVENT, new Error(`login failed due to an error: ${error.message}`));
		}
		return this.p_session;
	}

	async _login2() {
		if (this.p_session) return this.p_session;
		try {
			this.p_session = await new Promise(async (resolve, reject) => {
				let data = "fef030000305a600" + P_SESSION + "ff0301000000" + this.phone_id + "00000000" + this._get_time_stamp() + "00000000000000000000f0fe" +
					this.device_id + "00";
				data = this._crc_sign_full_packet_com_key(data, P_KEY);
				this.log("login...");
				try {
					var socket = await this._getsocket();
				} catch (err) {
					reject(err)
					return
				}
				this.log('sending data')
				this.log(data)
				socket.write(Buffer.from(data, 'hex'));
				socket.once('data', (data) => {
					var result_session = data.toString('hex').substr(16, 8)
					this.log('received login data:')
					this.log(data.toString('hex'))
					// todo: make sure result_session exists
					this.log('received session id: ' + result_session);
					resolve(result_session); // returning _p_session after a successful login
				});
				this.socket.once('error', (error) => {
					reject(error);
				});
			});
		}
		catch (error) {
			this.log('login failed due to an error', error);
			this.emit(ERROR_EVENT, new Error(`login failed due to an error: ${error.message}`));
		}
		return this.p_session;
	}

	async _login3() {
		if (this.p_session) return this.p_session;
		try {
			this.p_session = await new Promise(async (resolve, reject) => {
				let data1 = "fef030000305a600" + P_SESSION + "ff0301000000" +"00"+ this.token + "00" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id + "00";
				data1 = this._crc_sign_full_packet_com_key(data1, P_KEY);
				let data2 = "fef053000305a100" + P_SESSION + "f50301000000" + this.device_id+ "000000" + this._get_time_stamp() + "00000000000000000000f0fe" +"0000" + this.token + "000000000000000000000000000000000000000000000000000000000000000001"
				data2 = this._crc_sign_full_packet_com_key(data2, P_KEY);
				this.log("login1...");
				try {
					var socket = await this._getsocket();
				} catch (err) {
					reject(err)
					return
				}
				this.log('sending data1')
				this.log(data1)
				socket.write(Buffer.from(data1, 'hex'));
				socket.once('data', (data1) => {
					var result_session = data1.toString('hex').substr(16, 8)
					this.log('received login data1:')
					this.log(data1.toString('hex'))
					// todo: make sure result_session exists
					this.log('received session id: ' + result_session);
					// send second packet after receiving response to first packet
					this.log('sending data2')
					this.log(data2)
					socket.write(Buffer.from(data2, 'hex'));
					socket.once('data', (data2) => {
						this.log('received login data2:')
						this.log(data2.toString('hex'))
						this.log('received session id: ' + result_session);
						resolve(result_session); // returning _p_session after a successful login
					});
				});
				this.socket.once('error', (error) => {
					reject(error);
				});
			});
		}
		catch (error) {
			this.log('login failed due to an error', error);
			this.emit(ERROR_EVENT, new Error(`login failed due to an error: ${error.message}`));
		}
		return this.p_session;
	}



	async _run_power_command(command_type) {
		let p_session = await this._login();
		let data = "fef05d0002320102" + p_session + "340001" + "000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id +
			"00" + this.phone_id + "0000" + this.device_pass + "000000000000000000000000000000000000000000000000000000000106000" + command_type;
		data = this._crc_sign_full_packet_com_key(data, P_KEY);
		this.log('sending ' + Object.keys({ OFF, ON })[command_type.substr(0, 1)] + ' command');
		let socket = await this._getsocket();
		this.log('sending data:')
		this.log(data)
		try {
			socket = await this._getsocket();
		} catch (err) {
			this.log(err)
			return
		}
		socket.write(Buffer.from(data, 'hex'));
		socket.once('data', (data) => {
			this.log('data received:')
			this.log(data.toString('hex'))
			this.emit(STATE_CHANGED_EVENT, command_type.substr(0, 1));
		});
	}

	async _run_general_command(command, precommand = "3701") {
		let data, p_session
		if(this.token && (this.device_type === 's11' || this.device_type === 's12' || /^sl(mini)?0\d$/.test(this.device_type))){
			p_session = await this._login3();
			this.p_session = null;
			data = "fef0000003050102" + p_session + "000000" + "000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id + 
				"00" + this.token + this.device_pass + "000000000000000000000000000000000000000000000000000000" + precommand + this._get_command_length(command + "00000000") + command + "00000000"
		} else {
			p_session = await this._login2();
			this.p_session = null;
			data = "fef0000003050102" + p_session + "000000" + "000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id +
				"00" + this.phone_id + "0000" + this.device_pass + "000000000000000000000000000000000000000000000000000000" + precommand + this._get_command_length(command) + command
		}

		data = this._set_message_length(data)
		data = this._crc_sign_full_packet_com_key(data, P_KEY);
		var socket = await this._getsocket();
		this.log('sending data:')
		this.log(data)
		socket.write(Buffer.from(data, 'hex'));
		socket.once('data', (data) => {
			this.log('data received:')
			this.log(data.toString('hex'))
		});
	}

	_get_time_stamp() {
		var time_in_seconds = Math.round(new Date().getTime() / 1000);
		return struct.pack('<I', parseInt(time_in_seconds)).toString('hex');
	}

	_timer_value(minutes) {
		if (minutes == 0) return "00000000";  // when duration set to zero, Switcher sends regular on command
		var seconds = parseInt(minutes) * 60;
		return struct.pack('<I', seconds).toString('hex');
	}

	_set_default_shutdown(seconds) {
		if (seconds < 3600) {
			this.log('Value Can\'t be less than 1 hour!, setting to 3600')
			seconds = 3600
		} else if (seconds > 86340) {
			this.log('Value can\'t be more than 23 hours and 59 minutes, setting to 86340')
			seconds = 86340
		} else return struct.pack('<I', seconds).toString('hex');
	}

	_get_hex_pos(pos = 0) {
		var hex = Number(pos).toString(16);
		if (hex.length < 2) {
			hex = "0" + hex;
		}
		return hex
	}
	_get_breeze_command_key(state) {
		let command = ''

		// add mode
		command += Object.keys(breeze_dictionary.modes).find(key => breeze_dictionary.modes[key] === state.mode)

		// add temp & sanitize
		if (['COOL', 'HEAT'].includes(state.mode)) {
			if (state.target_temp > this.breeze_remote.max_temp)
				command += this.breeze_remote.max_temp
			else if (state.target_temp < this.breeze_remote.min_temp)
				command += this.breeze_remote.min_temp
			else command += state.target_temp || this.breeze_remote.min_temp
		}

		// add fan level
		if (this.breeze_remote.fan_levels && this.breeze_remote.fan_levels.includes(state.fan_level))
			command += `_${Object.keys(breeze_dictionary.fan_levels).find(key => breeze_dictionary.fan_levels[key] === state.fan_level)}`

		// add swing
		if (!this.breeze_remote.separated_swing && this.breeze_remote.swing && state.swing === 'ON')
			command += `_d1`

		return command
	}
	_get_udp_for_remote() {
		return new Promise(async (resolve, reject) => {
			let p_session = await this._login2();
			let data = "fef0300003050103" + p_session + "390001000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id + "00"
			data = this._crc_sign_full_packet_com_key(data, P_KEY);
			var socket = await this._getsocket();
			socket.write(Buffer.from(data, 'hex'));
			socket.once('data', (data) => {
				resolve(data.toString('hex'));
			});
			socket.on('error', (error) => {
				reject(error)
			});
		})
	}

	_crc_sign_full_packet_com_key(p_data, p_key) {
		var crc = struct.pack('>I', crc16ccitt(Buffer.from(p_data, 'hex'), 0x1021)).toString('hex');
		p_data = p_data + crc.substr(6, 2) + crc.substr(4, 2);
		crc = crc.substr(6, 2) + crc.substr(4, 2) + Buffer.from(p_key).toString('hex');
		crc = struct.pack('>I', crc16ccitt(Buffer.from(crc, 'hex'), 0x1021)).toString('hex');
		p_data = p_data + crc.substr(6, 2) + crc.substr(4, 2);
		return p_data
	}

	_set_message_length(data) {
		let hex = Number(Buffer.byteLength(Buffer.from(data + "00000000", "hex"))).toString(16)
		hex = hex.padStart(4, "0")
		hex = hex.substr(2, 2) + hex.substr(0, 2);
		return "fef0" + hex + data.substr(8)
	}

	_get_command_length(command) {
		let hex = Number(Buffer.byteLength(Buffer.from(command, "hex"))).toString(16)
		hex = hex.padStart(4, "0")
		hex = hex.substr(2, 2) + hex.substr(0, 2);
		return hex
	}


	_ascii_to_hex(str) {
		const arr1 = [];
		for (let n = 0, l = str.length; n < l; n++) {
			const hex = Number(str.charCodeAt(n)).toString(16);
			arr1.push(hex);
		}
		return arr1.join('');
	}

}

module.exports = {
	Switcher: Switcher,
	ConnectionError: ConnectionError
}