'use strict';
const { EventEmitter } = require('events');
module.exports = {
	spawn: (command, args, opts) => {
		global.__acpSpawned.push({ command, args, opts });
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { write: (data) => { global.__acpStdin = data; }, on: () => {}, end: () => {} };
		child.kill = () => { global.__acpKilled = true; };
		global.__acpChild = child;
		global.__acpChildren.push(child);
		return child;
	},
};
