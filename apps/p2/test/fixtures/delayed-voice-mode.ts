// Delay only the browser's VoiceMode hold; all other real Chord traffic continues.
import { binaryCodec } from "@earendil-works/chord";

const send = WebSocket.prototype.send;
const queued: { socket: WebSocket; data: Parameters<WebSocket["send"]>[0] }[] = [];
let blocked = true;
WebSocket.prototype.send = function (data) {
	if (blocked && new URL(this.url).pathname === "/chord" && data instanceof Uint8Array) {
		const message = binaryCodec.decode(data);
		if (message.kind === "hold" && message.type === "p2.voice-mode") {
			queued.push({ socket: this, data });
			return;
		}
	}
	send.call(this, data);
};
Object.assign(window, {
	voiceHoldsWaiting: () => queued.length,
	releaseVoiceHolds: () => {
		blocked = false;
		for (const { socket, data } of queued) send.call(socket, data);
		queued.length = 0;
	},
});
