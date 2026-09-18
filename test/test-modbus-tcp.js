// ═══════════════════════════════════════════════════════════════════════════
// Banco de pruebas del modo Modbus TCP — node-red-contrib-rtu-over-tcp
//
//   node test/test-modbus-tcp.js
//
// Levanta un esclavo Modbus TCP simulado y comprueba, contra el codigo real:
//   1. La peticion sale con cabecera MBAP correcta (proto=0, length, unitId)
//   2. Una lectura FC03 decodifica bien los registros con signo
//   3. Una lectura FC01 decodifica bien los coils
//   4. Una excepcion Modbus llega como error legible, sin agotar el timeout
//   5. Una escritura FC06 devuelve el eco del registro
//   6. Una respuesta fragmentada en varios paquetes TCP se ensambla bien
//   7. Una respuesta rezagada (TID viejo) se descarta y NO contamina la lectura
//   8. El Transaction ID cambia en cada transaccion
//   9. Apuntar el modo TCP a un equipo RTU da un error claro, no un timeout
// ═══════════════════════════════════════════════════════════════════════════
const net = require('net');
const path = require('path');
const EventEmitter = require('events');

let RotClientCtor = null;
const RED = {
    nodes: {
        createNode(node) {
            Object.setPrototypeOf(node, EventEmitter.prototype);
            EventEmitter.call(node);
            node.id = 'testclient';
        },
        registerType(name, ctor) { if (name === 'rot-client') RotClientCtor = ctor; }
    }
};
require(path.join(__dirname, '..', 'rot-client.js'))(RED);

// ── Utilidades MBAP para fabricar respuestas ──────────────────────────────
function mbap(tid, unitId, pdu) {
    const f = Buffer.alloc(7 + pdu.length);
    f.writeUInt16BE(tid, 0);
    f.writeUInt16BE(0, 2);
    f.writeUInt16BE(pdu.length + 1, 4);
    f[6] = unitId;
    pdu.copy(f, 7);
    return f;
}
function pduRegistros(fc, valores) {
    const p = Buffer.alloc(2 + valores.length * 2);
    p[0] = fc; p[1] = valores.length * 2;
    valores.forEach((v, i) => p.writeUInt16BE(v & 0xFFFF, 2 + i * 2));
    return p;
}
function pduCoils(fc, bytes) {
    const p = Buffer.alloc(2 + bytes.length);
    p[0] = fc; p[1] = bytes.length;
    Buffer.from(bytes).copy(p, 2);
    return p;
}
function pduExcepcion(fc, codigo) { return Buffer.from([fc | 0x80, codigo]); }
function pduEco(fc, reg, valor) {
    const p = Buffer.alloc(5);
    p[0] = fc;
    p.writeUInt16BE(reg, 1);
    p.writeUInt16BE(valor & 0xFFFF, 3);
    return p;
}
function crc16(buf) {
    let crc = 0xFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
    return crc;
}

// ── Esclavo Modbus TCP simulado ───────────────────────────────────────────
let modo = 'ok';
const peticiones = [];        // frames recibidos, para inspeccionar la MBAP

const server = net.createServer(sock => {
    sock.on('data', req => {
        peticiones.push(Buffer.from(req));
        const tid    = req.readUInt16BE(0);
        const unitId = req[6];
        const fc     = req[7];

        if (modo === 'ok') {
            if (fc === 0x03 || fc === 0x04)
                sock.write(mbap(tid, unitId, pduRegistros(fc, [85, 170, 0, 0, 1, 215, -40])));
            else if (fc === 0x01 || fc === 0x02)
                sock.write(mbap(tid, unitId, pduCoils(fc, [0b00001011])));
            else
                sock.write(mbap(tid, unitId, pduEco(fc, req.readUInt16BE(8), req.readUInt16BE(10))));

        } else if (modo === 'excepcion') {
            sock.write(mbap(tid, unitId, pduExcepcion(fc, 0x02)));

        } else if (modo === 'fragmentado') {
            const full = mbap(tid, unitId, pduRegistros(fc, [85, 170, 0, 0, 1, 215, -40]));
            sock.write(full.slice(0, 5));                       // cabecera a medias
            setTimeout(() => sock.write(full.slice(5)), 120);   // resto, tarde

        } else if (modo === 'rezagada') {
            // Primero una respuesta con un TID viejo (basura de otra
            // transaccion) y despues la buena. La primera debe descartarse.
            sock.write(mbap((tid + 5000) & 0xFFFF, unitId, pduRegistros(fc, [1, 2, 3, 4, 5, 6, 7])));
            sock.write(mbap(tid, unitId, pduRegistros(fc, [85, 170, 0, 0, 1, 215, -40])));

        } else if (modo === 'esRTU') {
            // El equipo contesta un frame RTU crudo aunque le hablemos MBAP
            const cuerpo = Buffer.alloc(3 + 14);
            cuerpo[0] = unitId; cuerpo[1] = 0x03; cuerpo[2] = 14;
            const f = Buffer.alloc(cuerpo.length + 2);
            cuerpo.copy(f);
            const c = crc16(cuerpo);
            f[cuerpo.length] = c & 0xFF; f[cuerpo.length + 1] = (c >> 8) & 0xFF;
            sock.write(f);
        }
    });
});

let fallos = 0;
function comprobar(nombre, condicion, detalle) {
    if (condicion) {
        console.log('  \x1b[32mPASA\x1b[0m  ' + nombre);
    } else {
        fallos++;
        console.log('  \x1b[31mFALLA\x1b[0m ' + nombre + (detalle ? '\n         -> ' + detalle : ''));
    }
}

server.listen(15021, '127.0.0.1', async () => {
    const node = Object.create(EventEmitter.prototype);
    RotClientCtor.call(node, {
        host: '127.0.0.1', port: 15021, timeout: 2,
        protocol: 'tcp', gap: 0, gapError: 100
    });

    let err = null, datos = null, t, ms;

    console.log('\n── 1. Cabecera MBAP de la petición ' + '─'.repeat(34));
    modo = 'ok';
    peticiones.length = 0;
    await node.read(7, 3, 100, 7);
    const p = peticiones[0];
    comprobar('longitud total = 12 bytes (MBAP 7 + PDU 5)', p.length === 12, p.length + ' bytes');
    comprobar('Protocol ID = 0', p.readUInt16BE(2) === 0, String(p.readUInt16BE(2)));
    comprobar('Length = 6 (unitId + PDU)', p.readUInt16BE(4) === 6, String(p.readUInt16BE(4)));
    comprobar('Unit ID = 7', p[6] === 7, String(p[6]));
    comprobar('FC = 3 y registro inicial = 100',
        p[7] === 3 && p.readUInt16BE(8) === 100, 'fc=' + p[7] + ' reg=' + p.readUInt16BE(8));
    comprobar('sin CRC al final (la PDU acaba en el count)',
        p.readUInt16BE(10) === 7, String(p.readUInt16BE(10)));

    console.log('\n── 2. Lectura FC03 de registros ' + '─'.repeat(37));
    datos = await node.read(1, 3, 0, 7);
    comprobar('devuelve 7 registros', datos.decimal.length === 7, JSON.stringify(datos.decimal));
    comprobar('decodifica valores con signo (-40)', datos.decimal[6] === -40, String(datos.decimal[6]));
    comprobar('salida hexadecimal coherente', datos.hex[5] === '0x00D7', datos.hex[5]);

    console.log('\n── 3. Lectura FC01 de coils ' + '─'.repeat(41));
    datos = await node.read(1, 1, 0, 4);
    comprobar('decodifica los bits en orden LSB-first',
        JSON.stringify(datos.decimal) === '[1,1,0,1]', JSON.stringify(datos.decimal));

    console.log('\n── 4. Excepción Modbus ' + '─'.repeat(46));
    modo = 'excepcion';
    t = Date.now(); err = null;
    try { await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    ms = Date.now() - t;
    comprobar('informa de excepcion Modbus', /Excepci/i.test(err && err.message),
        'mensaje recibido: "' + (err && err.message) + '"');
    comprobar('identifica el codigo 2 como direccion ilegal',
        /direccion de registro ilegal/i.test(err && err.message));
    comprobar('falla rapido (<500 ms), sin agotar el timeout', ms < 500, ms + ' ms');

    console.log('\n── 5. Escritura FC06 ' + '─'.repeat(48));
    modo = 'ok';
    err = null; let res = null;
    try { res = await node.writeFC06(1, 6, 220); } catch (e) { err = e; }
    comprobar('escribe sin error', !err, err && err.message);
    comprobar('devuelve el eco del registro y el valor',
        res && res.reg === 6 && res.value === 220, JSON.stringify(res));

    console.log('\n── 6. Respuesta fragmentada en varios paquetes TCP ' + '─'.repeat(18));
    modo = 'fragmentado';
    err = null; datos = null;
    try { datos = await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('ensambla los fragmentos sin error', !err, err && err.message);
    comprobar('decodifica los 7 registros',
        datos && datos.decimal.length === 7 && datos.decimal[5] === 215,
        datos && JSON.stringify(datos.decimal));

    console.log('\n── 7. Respuesta rezagada con TID viejo ' + '─'.repeat(30));
    modo = 'rezagada';
    err = null; datos = null;
    try { datos = await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('descarta la trama con TID ajeno', !err, err && err.message);
    comprobar('entrega los datos de LA transaccion correcta',
        datos && datos.decimal[5] === 215, datos && JSON.stringify(datos.decimal));

    console.log('\n── 8. Transaction ID incremental ' + '─'.repeat(36));
    modo = 'ok';
    peticiones.length = 0;
    await node.read(1, 3, 0, 7);
    await node.read(1, 3, 0, 7);
    const tids = peticiones.map(b => b.readUInt16BE(0));
    comprobar('el TID cambia entre transacciones', tids[0] !== tids[1], 'tids: ' + tids.join(', '));
    comprobar('el TID nunca es 0', tids.every(v => v !== 0), 'tids: ' + tids.join(', '));

    console.log('\n── 9. Modo TCP contra un equipo que habla RTU ' + '─'.repeat(23));
    modo = 'esRTU';
    t = Date.now(); err = null;
    try { await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    ms = Date.now() - t;
    comprobar('avisa de cabecera MBAP invalida', /MBAP/i.test(err && err.message),
        'mensaje recibido: "' + (err && err.message) + '"');
    comprobar('sugiere revisar el protocolo', /RTU over TCP/i.test(err && err.message));
    comprobar('falla rapido, sin agotar el timeout de 2 s', ms < 500, ms + ' ms');

    console.log('\n' + '═'.repeat(70));
    console.log(fallos === 0
        ? '\x1b[32mTodas las pruebas de Modbus TCP pasan.\x1b[0m'
        : '\x1b[31m' + fallos + ' prueba(s) fallan.\x1b[0m');
    console.log('═'.repeat(70) + '\n');

    node._queue.destroy();
    server.close();
    process.exit(fallos === 0 ? 0 : 1);
});
