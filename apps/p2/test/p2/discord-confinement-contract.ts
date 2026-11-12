// Worker-owned setup and observations for the Discord confinement integration fixture.

import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { method, param, remote, sessionHost } from "@p2/app/v1";
import { LocationSchema } from "../../src/runtime/location.ts";

export const ConfinementProbe = remote("test.discord-confinement", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			methods: {
				startBackground: method(),
				armInput: method(),
				inputEntered: method(),
				releaseInput: method(),
				seed: method(
					obj({
						name: str(),
						location: opt(LocationSchema),
						parent: opt(num()),
						archived: opt(bool()),
						legacy: opt(bool()),
					}),
					num(),
				),
				inspect: method(
					obj({ conversation: num() }),
					obj({ location: LocationSchema, marker: str(), generation: num(), history: bool() }),
				),
			},
		},
	},
});
