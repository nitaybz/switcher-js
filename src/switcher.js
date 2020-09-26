"use strict";

const net = require('net');
const dgram = require('dgram');
const struct = require('python-struct');
const EventEmitter = require('events').EventEmitter;

const crc16ccitt = require('./crc').crc16ccitt;


const P_SESSION = '00000000';
const P_KEY = '00000000000000000000000000000000';

const STATUS_EVENT = 'status';
const READY_EVENT = 'ready';
const ERROR_EVENT = 'error';
const STATE_CHANGED_EVENT = 'state';
const DURATION_CHANGED_EVENT = 'duration'


const SWITCHER_UDP_IP = "0.0.0.0"
const SWITCHER_UDP_PORT = 20002

const OFF = 0;
const ON = 1;


class ConnectionError extends Error {
    constructor(ip, port) {
        super(`connection error: failed to connect to switcher on ip: ${ip}:${port}. please make sure it is turned on and available.`);
        this.ip = ip;
        this.port = port;
    }
}

class SwitcherUDPMessage {
    constructor(message_buffer) {
        this.data_str = message_buffer.toString();
        this.data_hex = message_buffer.toString('hex');
    }

    static is_valid(message_buffer) {
        return !(message_buffer.toString('hex').substr(0, 4) != 'fef0' && 
                 message_buffer.byteLength != 165);
    }

    extract_ip_addr() {
        var ip_addr_section = this.data_hex.substr(152, 8);
        var ip_addr_int = parseInt(
            ip_addr_section.substr(0, 2) + 
            ip_addr_section.substr(2, 2) +
            ip_addr_section.substr(4, 2) +
            ip_addr_section.substr(6, 2), 16);
        return this.inet_ntoa(ip_addr_int);
    }

    extract_device_name() {
        return this.data_str.substr(40, 32).replace(/\0/g, ''); // remove leftovers after the name
    }

    extract_device_id() {
        return this.data_hex.substr(36, 6);
    }

    extract_switch_state() {
        return this.data_hex.substr(266, 4) == '0000' ? OFF : ON;
    }

    extract_shutdown_remaining_seconds() {
        var time_left_section = this.data_hex.substr(294, 8); 
        return parseInt(
            time_left_section.substr(6, 2) + 
            time_left_section.substr(4, 2) + 
            time_left_section.substr(2, 2) + 
            time_left_section.substr(0, 2), 16);
    }

    extract_default_shutdown_seconds() {
        var shutdown_settings_section = this.data_hex.substr(310, 8); 
        return parseInt(
            shutdown_settings_section.substr(6, 2) + 
            shutdown_settings_section.substr(4, 2) + 
            shutdown_settings_section.substr(2, 2) + 
            shutdown_settings_section.substr(0, 2), 16);
    }
    
    extract_power_consumption() {
        var power_consumption_section = this.data_hex.substr(270, 4); 
        return parseInt(
            power_consumption_section.substr(2, 2) + 
            power_consumption_section.substr(0, 2), 16);
    }

    inet_ntoa(num) { // extract to utils https://stackoverflow.com/a/21613691
        var a = ((num >> 24) & 0xFF) >>> 0;
        var b = ((num >> 16) & 0xFF) >>> 0;
        var c = ((num >> 8) & 0xFF) >>> 0;
        var d = (num & 0xFF) >>> 0;
        return(a + "." + b + "." + c + "." + d);
    }
} 


class Switcher extends EventEmitter { 
    constructor(device_id, switcher_ip, log) {
        super();
        this.device_id = device_id;
        this.switcher_ip = switcher_ip;
        this.phone_id = '0000';
        this.device_pass = '00000000';
        this.SWITCHER_PORT = 9957;
        this.log = log;
        this.p_session = null;
        this.socket = null;
        this.status_socket = this._hijack_status_report();
    }

    static discover(log, identifier, discovery_timeout) {
        var proxy = new EventEmitter.EventEmitter();
        var timeout = null
        var socket = dgram.createSocket('udp4', (raw_msg, rinfo) => {
            var ipaddr = rinfo.address;
            if (!SwitcherUDPMessage.is_valid(raw_msg)) {
                return; // ignoring - not a switcher broadcast message
            }
            var udp_message = new SwitcherUDPMessage(raw_msg);
            var device_id = udp_message.extract_device_id();
            var device_name = udp_message.extract_device_name();
            if (identifier && identifier !== device_id && identifier !== device_name && identifier !== ipaddr) {
                log.debug(`Found ${device_name} (${ipaddr}) - Not the device we\'re looking for!`);
                return;
            }

            // log(`Found ${device_name} (${ipaddr})!`);
            proxy.emit(READY_EVENT, new Switcher(device_id, ipaddr, log));
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
        socket.bind(SWITCHER_UDP_PORT, SWITCHER_UDP_IP);
        if (discovery_timeout);
            timeout = setTimeout(() => {
                log.debug(`stopping discovery, closing socket`);
                socket.close();
                socket = null;
            }, discovery_timeout*1000);

        proxy.close = () => {
            log.debug('closing discover socket');
            if (socket) {
                socket.close();
                log.debug('discovery socket is closed');
            }
        }
        return proxy;
    }

    turn_off() {
        var off_command = OFF + '00' + '00000000';
        this._run_power_command(off_command);
    }

    turn_on(duration=0) {
        var on_command = ON +'00' + this._timer_value(duration);
        this._run_power_command(on_command);
    }

    async set_default_shutdown(duration=3600) {
        var auto_close = this._set_default_shutdown(duration)
        var p_session = await this._login(); 
        var data = "fef05b0002320102" + p_session + "340001000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id +
                   "00" + this.phone_id + "0000" + this.device_pass + "00000000000000000000000000000000000000000000000000000000040400" + auto_close;
        data = this._crc_sign_full_packet_com_key(data, P_KEY);
        this.log.debug(`sending default_shutdown command | ${duration} seconds`);
        var socket = await this._getsocket();
        socket.write(Buffer.from(data, 'hex'));
        socket.once('data', (data) => {
            this.emit(DURATION_CHANGED_EVENT, duration); // todo: add old state and new state
        });

    }

    async status(callback) {  // refactor
        var p_session = await this._login(); 
        var data = "fef0300002320103" + p_session + "340001000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id + "00";
        data = this._crc_sign_full_packet_com_key(data, P_KEY);
        var socket = await this._getsocket();
        socket.write(Buffer.from(data, 'hex'));
        socket.once('data', (data) => {
            var device_name = data.toString().substr(40, 32).replace(/\0/g, '');;
            var state_hex = data.toString('hex').substr(150, 4);
            var state = state_hex == '0000' ? OFF : ON; 
            var b = data.toString('hex').substr(178, 8); 
            var remaining_seconds = parseInt(b.substr(6, 2) + b.substr(4, 2) + b.substr(2, 2) + b.substr(0, 2), 16);
            b = data.toString('hex').substr(194, 8);
            var default_shutdown_seconds = parseInt(b.substr(6, 2) + b.substr(4, 2) + b.substr(2, 2) + b.substr(0, 2), 16);
            b = data.toString('hex').substr(154, 4); 
            var power_consumption = parseInt(b.substr(2, 2) + b.substr(0, 2), 16);
            callback({
                name: device_name,
                state: state,
                remaining_seconds: remaining_seconds,
                default_shutdown_seconds: default_shutdown_seconds,
                power_consumption: power_consumption
            });
        });
    }

    close() {
        if (this.socket && !this.socket.destroyed) {
            this.log.debug('closing sockets');
            this.socket.destroy();
            this.log.debug('main socket is closed');
        }
        if (this.status_socket && !this.status_socket.destroyed) {
            this.log.debug('closing sockets');
            this.status_socket.close();
            this.log.debug('status socket is closed');
        }
    }

    async _getsocket() {
        if (this.socket && !this.socket.destroyed) {
            return await this.socket;
        }
        try {
            var socket = await this._connect(this.SWITCHER_PORT, this.switcher_ip);
            socket.on('error', (error) => {
                this.log.debug('gloabal error event:', error);
            });
            socket.on('close', (had_error) => {
                this.log.debug('gloabal close event:', had_error);
            });
            this.socket = socket;
            return socket;
        }
        catch(error) {
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
                this.log.debug('successful connection, socket was created');
                resolve(socket);
            });
            socket.once('close', (had_error) => {
                this.log.debug('connection closed, had error:', had_error)
                reject(had_error);
            });
            socket.once('error', (error) => {
                this.log.debug('connection rejected, error:', error)
                reject(error);
            });
        });
    }

    _hijack_status_report() {
        var socket = dgram.createSocket('udp4', (raw_msg, rinfo) => {
            if (!SwitcherUDPMessage.is_valid(raw_msg)) {
                return; // ignoring - not a switcher broadcast message
            }
            var udp_message = new SwitcherUDPMessage(raw_msg);
            this.emit(STATUS_EVENT, {
                name: udp_message.extract_device_name(),
                state: udp_message.extract_switch_state(),
                remaining_seconds: udp_message.extract_shutdown_remaining_seconds(),
                default_shutdown_seconds: udp_message.extract_default_shutdown_seconds(),
                power_consumption: udp_message.extract_power_consumption()
            })
        });
        socket.on('error', (error) => {
            this.emit(ERROR_EVENT, new Error("status report failed. error: " + error.message)); // hoping this will keep the original stack trace
        });
        socket.bind(SWITCHER_UDP_PORT, SWITCHER_UDP_IP);
        return socket;
    }

    async _login() {
        if (this.p_session) return this.p_session;
        try {
            this.p_session = await new Promise(async (resolve, reject) => {
                var data = "fef052000232a100" + P_SESSION + "340001000000000000000000"  + this._get_time_stamp() + "00000000000000000000f0fe1c00" + 
                           this.phone_id + "0000" + this.device_pass + "00000000000000000000000000000000000000000000000000000000";
                data = this._crc_sign_full_packet_com_key(data, P_KEY);
                this.log.debug("login...");
                try {
                    var socket = await this._getsocket();
                } catch (err) {
                    reject(err)
                    return
                }
                socket.write(Buffer.from(data, 'hex'));
                socket.once('data', (data) => {
                    var result_session = data.toString('hex').substr(16, 8)  
                    // todo: make sure result_session exists
                    this.log.debug('recieved session id: ' + result_session);
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

    async _run_power_command(command_type) {
        var p_session = await this._login(); 
        var data = "fef05d0002320102" + p_session + "340001000000000000000000" + this._get_time_stamp() + "00000000000000000000f0fe" + this.device_id +
                   "00" + this.phone_id + "0000" + this.device_pass + "000000000000000000000000000000000000000000000000000000000106000" + command_type;
        data = this._crc_sign_full_packet_com_key(data, P_KEY);
        this.log.debug('sending ' + Object.keys({OFF, ON})[command_type.substr(0, 1)] +  ' command');
        var socket = await this._getsocket();
        try {
            var socket = await this._getsocket();
        } catch (err) {
            this.log.debug(err)
            return
        }
        socket.write(Buffer.from(data, 'hex'));
        socket.once('data', (data) => {
            this.emit(STATE_CHANGED_EVENT, command_type.substr(0, 1)); // todo: add old state and new state
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
            this.log.debug('Value Can\'t be less than 1 hour!, setting to 3600')
            seconds = 3600
        } else if (seconds > 86340) {
            this.log.debug('Value can\'t be more than 23 hours and 59 minutes, setting to 86340')
            seconds = 86340
        } else return struct.pack('<I', seconds).toString('hex');
    }

    _crc_sign_full_packet_com_key(p_data, p_key) {
        var crc = struct.pack('>I', crc16ccitt(Buffer.from(p_data, 'hex'), 0x1021)).toString('hex');
        p_data = p_data + crc.substr(6, 2) + crc.substr(4, 2);
        crc = crc.substr(6, 2) + crc.substr(4, 2) + Buffer.from(p_key).toString('hex');
        crc = struct.pack('>I', crc16ccitt(Buffer.from(crc, 'hex'), 0x1021)).toString('hex');
        p_data = p_data + crc.substr(6, 2) + crc.substr(4, 2);
        return p_data
    }
}

module.exports = {
    Switcher: Switcher,
    ConnectionError: ConnectionError,
    ON: ON,
    OFF, OFF
}