// ═══════════════════════════════════════════════════════════════════════════
// Banco de pruebas del modo Modbus RTU por puerto serie
//
//   node test/test-rtu-serie.js
//
// Necesita 'socat' (crea un par de puertos serie virtuales enlazados) y el
// modulo 'serialport' (npm install en la raiz del paquete).
//
// Comprueba, contra el codigo real:
//   1. La peticion sale como trama RTU correcta (slave + PDU + CRC16)
//   2. Una lectura FC03 decodifica bien los registros
//   3. Una excepcion Modbus llega como error legible, sin agotar el timeout
//   4. Una escritura FC06 devuelve el eco del registro
//   5. Una respuesta que llega byte a byte se ensambla bien
//   6. La opcion de eco local descarta la propia peticion devuelta por RX
//   7. El silencio entre tramas nunca baja del t3.5 del bus
//   8. Un puerto inexistente da un error claro y no tumba el proceso
//   9. Dos clientes sobre la misma ruta: el segundo avisa de puerto ocupado
//  10. destroy() libera el puerto de verdad: se puede reabrir enseguida
//  11. El listado de puertos no tumba el proceso aunque falte udevadm
//  12. destroy() durante un open() pendiente espera al cierre real
//  13. Una configuracion serie invalida NO programa reintentos
//
// Si faltan 'serialport' o 'socat' la suite FALLA (codigo 1): una suite
// saltada que devuelve 0 hace que 'npm test' salga verde sin haber probado
// nada. Para probar solo los modos TCP: npm run test:sin-serie
// ═══════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const EventEmitter = require('events');

function noSePuedeProbar(motivo) {
    if (process.env.ROT_OMITIR_SERIE === '1') {
        console.log('\n\x1b[33m[OMITIDA]\x1b[0m suite RTU serie: ' + motivo + ' (ROT_OMITIR_SERIE=1)\n');
        process.exit(0);
    }
    console.log('\n\x1b[31m[ERROR]\x1b[0m la suite RTU serie NO se ha ejecutado: ' + motivo +
        '\n        Instala lo que falta, o ejecuta "npm run test:sin-serie" para probar solo los modos TCP.\n');
    process.exit(1);
}

let SerialPort;
try { SerialPort = require('serialport').SerialPort; }
catch (e) { noSePuedeProbar("falta el modulo 'serialport' (ejecuta npm ci)"); }
if (spawnSync('which', ['socat']).status !== 0) noSePuedeProbar("falta 'socat' (apt install socat)");

let RotClientCtor = null;
let handlerPuertos = null;
const RED = {
    nodes: {
        createNode(node) {
            Object.setPrototypeOf(node, EventEmitter.prototype);
            EventEmitter.call(node);
            node.id = 'testclient';
        },
        registerType(name, ctor) { if (name === 'rot-client') RotClientCtor = ctor; }
    },
    httpAdmin: { get(ruta, permiso, handler) { if (ruta === '/rot-client/puertos') handlerPuertos = handler; } },
    auth: { needsPermission: () => (req, res, next) => next() }
};
require(path.join(__dirname, '..', 'rot-client.js'))(RED);

// ── Utilidades RTU ────────────────────────────────────────────────────────
function crc16(buf) {
    let crc = 0xFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
    return crc;
}
function conCRC(cuerpo) {
    const f = Buffer.alloc(cuerpo.length + 2);
    cuerpo.copy(f);
    const c = crc16(cuerpo);
    f[cuerpo.length] = c & 0xFF; f[cuerpo.length + 1] = (c >> 8) & 0xFF;
    return f;
}
function respuestaRegistros(slave, fc, valores) {
    const c = Buffer.alloc(3 + valores.length * 2);
    c[0] = slave; c[1] = fc; c[2] = valores.length * 2;
    valores.forEach((v, i) => c.writeUInt16BE(v & 0xFFFF, 3 + i * 2));
    return conCRC(c);
}
const excepcion = (slave, fc, cod) => conCRC(Buffer.from([slave, fc | 0x80, cod]));
const eco = (req) => Buffer.from(req);   // FC06 responde con la misma trama

const esperar = ms => new Promise(r => setTimeout(r, ms));

function nuevoCliente(extra) {
    const node = Object.create(EventEmitter.prototype);
    RotClientCtor.call(node, Object.assign({
        protocol: 'serial', serialPort: '/tmp/rot-mA', baudRate: 9600,
        dataBits: 8, parity: 'none', stopBits: 1, timeout: 1, gap: 20, gapError: 100
    }, extra));
    return node;
}

let fallos = 0;
function comprobar(nombre, condicion, detalle) {
    if (condicion) console.log('  \x1b[32mPASA\x1b[0m  ' + nombre);
    else { fallos++; console.log('  \x1b[31mFALLA\x1b[0m ' + nombre + (detalle ? '\n         -> ' + detalle : '')); }
}

(async () => {
    // Par de puertos virtuales: el cliente usa A, el esclavo simulado usa B
    const socat = spawn('socat', ['pty,raw,echo=0,link=/tmp/rot-mA', 'pty,raw,echo=0,link=/tmp/rot-mB']);
    for (let i = 0; i < 40 && !(fs.existsSync('/tmp/rot-mA') && fs.existsSync('/tmp/rot-mB')); i++) await esperar(50);

    // ── Esclavo simulado ──────────────────────────────────────────────────
    let modo = 'ok';
    const peticiones = [];
    let rx = Buffer.alloc(0);
    const esclavo = new SerialPort({ path: '/tmp/rot-mB', baudRate: 9600 });
    await new Promise(r => esclavo.on('open', r));

    esclavo.on('data', async chunk => {
        rx = Buffer.concat([rx, chunk]);
        while (rx.length >= 8) {                 // todas las peticiones del test son de 8 bytes
            const req = rx.slice(0, 8); rx = rx.slice(8);
            peticiones.push(req);
            const slave = req[0], fc = req[1];
            let resp;
            if (modo === 'excepcion')           resp = excepcion(slave, fc, 0x02);
            else if (fc === 0x06)               resp = eco(req);
            else                                resp = respuestaRegistros(slave, fc, [85, 170, 0, 0, 1, 215, -40]);

            if (modo === 'eco') esclavo.write(req);          // adaptador con eco local
            if (modo === 'goteo') {
                for (const b of resp) { esclavo.write(Buffer.from([b])); await esperar(4); }
            } else {
                esclavo.write(resp);
            }
        }
    });

    const node = nuevoCliente();
    node.subscribe();
    let err, datos, t, ms;

    console.log('\n── 1. Trama RTU enviada por el puerto serie ' + '─'.repeat(25));
    peticiones.length = 0;
    await node.read(7, 3, 100, 7);
    const p = peticiones[0];
    comprobar('8 bytes: slave + FC + reg + count + CRC', p && p.length === 8);
    comprobar('slave 7, FC03, registro 100, count 7',
        p[0] === 7 && p[1] === 3 && p.readUInt16BE(2) === 100 && p.readUInt16BE(4) === 7);
    comprobar('CRC16 correcto', (p[6] | (p[7] << 8)) === crc16(p.slice(0, 6)));

    console.log('\n── 2. Lectura FC03 ' + '─'.repeat(50));
    datos = await node.read(1, 3, 0, 7);
    comprobar('decodifica 7 registros con signo',
        datos.decimal.length === 7 && datos.decimal[5] === 215 && datos.decimal[6] === -40,
        JSON.stringify(datos.decimal));

    console.log('\n── 3. Excepción Modbus ' + '─'.repeat(46));
    modo = 'excepcion'; err = null; t = Date.now();
    try { await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    ms = Date.now() - t;
    comprobar('informa de direccion ilegal', /direccion de registro ilegal/i.test(err && err.message),
        err && err.message);
    comprobar('falla rapido (<500 ms)', ms < 500, ms + ' ms');

    console.log('\n── 4. Escritura FC06 ' + '─'.repeat(48));
    modo = 'ok'; err = null; let res = null;
    try { res = await node.writeFC06(1, 6, 220); } catch (e) { err = e; }
    comprobar('devuelve el eco del registro', res && res.reg === 6 && res.value === 220,
        err ? err.message : JSON.stringify(res));

    console.log('\n── 5. Respuesta que llega byte a byte ' + '─'.repeat(31));
    modo = 'goteo'; err = null; datos = null;
    try { datos = await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('ensambla la trama sin error', !err, err && err.message);
    comprobar('valores correctos', datos && datos.decimal[5] === 215);

    console.log('\n── 6. Adaptador con eco local ' + '─'.repeat(39));
    modo = 'eco'; err = null;
    try { await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('SIN la opcion de eco, la lectura falla (el eco contamina)', !!err);
    await node._queue.destroy();
    await esperar(150); rx = Buffer.alloc(0);
    const nodeEco = nuevoCliente({ echo: true });
    nodeEco.subscribe();
    err = null; datos = null;
    try { datos = await nodeEco.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('CON la opcion de eco, la lectura es correcta', !err && datos.decimal[5] === 215,
        err && err.message);
    err = null; res = null;
    try { res = await nodeEco.writeFC06(1, 6, 220); } catch (e) { err = e; }
    comprobar('CON eco, la escritura tambien', !err && res.value === 220, err && err.message);
    await nodeEco._queue.destroy();
    modo = 'ok';

    console.log('\n── 7. Silencio mínimo t3.5 ' + '─'.repeat(42));
    const lento = nuevoCliente({ baudRate: 1200, gap: 0, gapError: 0 });
    comprobar('a 1200 baudios el gap sube de 0 a >= 33 ms', lento._queue.gapMs >= 33,
        'gapMs = ' + lento._queue.gapMs);
    const tcp = Object.create(EventEmitter.prototype);
    RotClientCtor.call(tcp, { protocol: 'tcp', host: '127.0.0.1', port: 1, timeout: 1, gap: 0 });
    comprobar('en Modbus TCP el gap 0 se respeta', tcp._queue.gapMs === 0);
    await lento._queue.destroy(); await tcp._queue.destroy();

    console.log('\n── 8. Puerto inexistente ' + '─'.repeat(44));
    const fantasma = nuevoCliente({ serialPort: '/dev/ttyNOEXISTE9' });
    let estado = null;
    fantasma.on('status', s => { estado = s.text; });
    fantasma.subscribe();
    err = null; t = Date.now();
    try { await fantasma.read(1, 3, 0, 1); } catch (e) { err = e; }
    ms = Date.now() - t;
    comprobar('la lectura falla con "Puerto no encontrado"', /no encontrado/i.test(err && err.message),
        err && err.message);
    comprobar('falla al momento, no se queda en cola', ms < 300, ms + ' ms');
    comprobar('el estado del nodo lo refleja', /no encontrado/i.test(estado || ''), estado);
    await fantasma._queue.destroy();

    console.log('\n── 9. Dos clientes en la misma ruta ' + '─'.repeat(33));
    const c1 = nuevoCliente(); c1.subscribe();
    await c1.read(1, 3, 0, 7);
    const c2 = nuevoCliente();
    let estado2 = null;
    c2.on('status', s => { estado2 = s.text; });
    c2._queue._subscribers = 1; c2._queue._connect();
    await esperar(300);
    comprobar('el segundo avisa de puerto ocupado', /ocupado/i.test(estado2 || ''), estado2);
    await c2._queue.destroy();

    console.log('\n── 10. destroy() libera el puerto ' + '─'.repeat(35));
    await c1._queue.destroy();              // lo que hace un deploy
    const c3 = nuevoCliente(); c3.subscribe();
    err = null;
    try { datos = await c3.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('el cliente del siguiente deploy abre la misma ruta al instante', !err, err && err.message);
    await c3._queue.destroy();

    console.log('\n── 11. Listado de puertos ' + '─'.repeat(43));
    let json = null, crash = null;
    const trampa = e => { crash = e; };
    process.once('uncaughtException', trampa);
    await new Promise(r => handlerPuertos({}, { json(o) { json = o; r(); } }));
    await esperar(200);
    process.removeListener('uncaughtException', trampa);
    comprobar('responde sin tumbar el proceso', !crash && json && Array.isArray(json.puertos),
        crash ? crash.message : JSON.stringify(json));
    comprobar('indica que serialport esta disponible', json && json.disponible === true);

    console.log('\n── 12. Cerrar durante un open() pendiente ' + '─'.repeat(27));
    const c5 = nuevoCliente(); c5.subscribe();
    c5._queue._connect();                    // lanza open() ...
    const puertoPendiente = c5._queue._socket;
    comprobar('(precondicion) el open() sigue en curso', puertoPendiente && puertoPendiente.opening === true);
    await c5._queue.destroy();               // ... y se cierra sin esperar
    comprobar('al cumplirse destroy() el puerto ya no se esta abriendo',
        !puertoPendiente.opening, 'opening=' + puertoPendiente.opening);
    comprobar('y tampoco sigue abierto', !puertoPendiente.isOpen, 'isOpen=' + puertoPendiente.isOpen);
    const c6 = nuevoCliente(); c6.subscribe();
    err = null;
    try { await c6.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('el cliente siguiente abre la ruta sin "Puerto ocupado"', !err, err && err.message);
    await c6._queue.destroy();

    console.log('\n── 13. Configuración serie inválida ' + '─'.repeat(33));
    for (const [desc, extra] of [['ruta vacia', { serialPort: '' }], ['baudios no numericos', { baudRate: 'abc' }]]) {
        const inval = nuevoCliente(extra);
        // parseInt('abc') da NaN y el cliente usaria 9600; se fuerza el valor
        // crudo para probar la rama del constructor que lanza.
        if (extra.baudRate) inval._queue.serial.baudRate = extra.baudRate;
        inval.subscribe();
        err = null;
        try { await inval.read(1, 3, 0, 1); } catch (e) { err = e; }
        comprobar(desc + ': error "Configuración serie inválida"',
            /Configuraci.n serie inv.lida/.test(err && err.message), err && err.message);
        comprobar(desc + ': NO programa reintentos', inval._queue._reconnectTimer === null);
        await inval._queue.destroy();
    }

    console.log('\n' + '═'.repeat(70));
    console.log(fallos === 0
        ? '\x1b[32mTodas las pruebas de RTU serie pasan.\x1b[0m'
        : '\x1b[31m' + fallos + ' prueba(s) fallan.\x1b[0m');
    console.log('═'.repeat(70) + '\n');

    esclavo.close(() => { socat.kill(); process.exit(fallos === 0 ? 0 : 1); });
})().catch(e => { console.error(e); process.exit(1); });
