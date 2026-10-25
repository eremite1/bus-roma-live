import { readFileSync } from 'node:fs';
import { decodeVehicleFeed } from '../js/gtfsrt.js';
const r = decodeVehicleFeed(readFileSync(process.argv[2]));
console.log(JSON.stringify(r, null, 1));
if (r.vehicles.length !== 4) throw new Error('attesi 4 veicoli');
if (r.timestamp !== 1793000000) throw new Error('ts');
if (r.vehicles[0].tripId !== 'T64A' || Math.abs(r.vehicles[0].lat-41.9009)>1e-4 || r.vehicles[0].bearing !== 270 || r.vehicles[0].directionId!==0) throw new Error('v0');
console.log('OK');
