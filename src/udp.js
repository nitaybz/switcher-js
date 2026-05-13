"use strict";

// 0104173000

const mode_commands = {
	'01': 'AUTO',
	'02': 'DRY',
	'03': 'FAN',
	'04': 'COOL',
	'05': 'HEAT'
}

const fan_commands = {
	'1': 'LOW',
	'2': 'MEDIUM',
	'3': 'HIGH',
	'0': 'AUTO'
}

const direction_commands = {
	'0000': 'STOP',
	'0100': 'UP',
	'0001': 'DOWN'
}

const types = {
	'01a8': 'power_plug',
	'01a1': 'v2_qca',
	'01a7': 'v2_esp',
	'030b': 'v3',
	'0317': 'v4',
	'030f': 'mini',
	'031f': 'heater',
	'0321': 'on_wall',
	'0c01': 'runner',
	'0c02': 'runner_mini',
	'0e01': 'breeze',
	'0f01': 's11',
	'0f02': 's12',
	'0f04': 'sl01',
	'0f05': 'sl02',
	'0f06': 'sl03',
	'0f07': 'slmini01',
	'0f08': 'slmini02'
}

class SwitcherUDPMessage {
	constructor(message_buffer) {
		this.message_buffer = message_buffer
		this.data_str = message_buffer.toString();
		this.data_hex = message_buffer.toString('hex');
	}

	static get_breeze_mode(hex) {
		return mode_commands[hex] || 'COOL'
	}
    
	static get_breeze_fan_level(hex) {
		return fan_commands[hex] || 'LOW'
	}

	static is_valid(message_buffer) {
		const isValid = (Buffer.isBuffer(message_buffer) && message_buffer.toString('hex').substr(0, 4) === 'fef0') ;
		// && (Buffer.byteLength(message_buffer) === 165 || Buffer.byteLength(message_buffer) === 159 || Buffer.byteLength(message_buffer) === 168));

		return isValid
	}

	extract_type() {
		var type_hex = this.data_hex.substr(148, 4); 
		return types[type_hex] || `unknown_${type_hex}`;
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
		return this.data_str.substr(38, 32).replace(/[^0-9a-zA-Z_\u0590-\u05fe\s]/g, '').replace(/\0/g, ''); // remove leftovers after the name
	}
	
	extract_device_key() {
		return this.data_hex.substr(80, 2)
	}

	extract_remote() {
		const remote = this.data_str.match(/(?<=_[A-Z0-9]{4}.*)([A-Z0-9]{8})/)
		if (remote && remote.length)
			return remote[0]
		else
			return 'UNKNOWN'
	}

	extract_device_id() {
		return this.data_hex.substr(36, 6);
	}

	extract_switch_state() {
		return this.data_hex.substr(266, 4) == '0000' ? 0 : 1;
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
    
	extract_position(index) {
		index --
		const command_index = 270 + (index ? index*32 : 0)
		var position_section = this.data_hex.substr(command_index, 2); 
		return parseInt(position_section.substr(0, 2), 16);
	}
    
	extract_child_lock(index) {
		index --
		const command_index = 272 + (index ? index*32 : 0)
		return this.data_hex.substr(command_index, 2) == '00' ? 'OFF' : 'ON';
	}

	extract_direction(index) {
		index --
		const command_index = 274 + (index ? index*32 : 0)
		var direction = this.data_hex.substr(command_index, 4); 
		return direction_commands[direction];
	}

	extract_light(index) {
		index --
		const command_index = 270 + (index ? index*32 : 0)
		return this.data_hex.substr(command_index, 2) == '00' ? 'OFF' : 'ON';
	}

	extract_current_temp() {
		var current_temp_section = this.data_hex.substr(270, 4); 
		return parseInt(
			current_temp_section.substr(2, 2) + 
            current_temp_section.substr(0, 2), 16)/10;
	}
    
	extract_ac_power() {
		return this.data_hex.substr(274, 2) == '00' ? 'OFF' : 'ON';
	}

	extract_ac_mode() {
		var mode = this.data_hex.substr(276, 2); 
		return mode_commands[mode] || 'COOL';
	}
    
	extract_target_temp() {
		var target_temp_section = this.data_hex.substr(278, 2); 
		return parseInt(target_temp_section, 16);
	}

	extract_fan_level() {
		var fan = this.data_hex.substr(280, 1); 
		return fan_commands[fan] || 'LOW';
	}

	extract_swing() {
		return this.data_hex.substr(281, 1) == '0' ? 'OFF' : 'ON';
	}

	// Switcher Heater (031f) UDP broadcast extractors. Offsets verified against
	// aioswitcher's DatagramParser (bridge.py). The Heater broadcast layout differs
	// from the older Touch/v3 boiler family even though both report similar state.
	extract_heater_state() {
		return this.data_hex.substr(270, 2) == '01' ? 1 : 0;
	}

	extract_heater_power_consumption() {
		var section = this.data_hex.substr(274, 4);
		return parseInt(section.substr(2, 2) + section.substr(0, 2), 16);
	}

	extract_heater_remaining_seconds() {
		var section = this.data_hex.substr(326, 8);
		return parseInt(
			section.substr(6, 2) +
			section.substr(4, 2) +
			section.substr(2, 2) +
			section.substr(0, 2), 16);
	}
}

module.exports = SwitcherUDPMessage