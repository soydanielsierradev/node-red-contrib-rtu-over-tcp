// ═══════════════════════════════════════════════════════════════════════════
// Banco de pruebas de regresion — node-red-contrib-rtu-over-tcp
//
//   node test/test-excepciones.js
//
// Levanta un esclavo Modbus simulado y comprueba, contra el codigo real:
//   1. Una LECTURA rechazada devuelve el error de excepcion, no "Respuesta corta"
//   2. Una ESCRITURA rechazada falla RAPIDO, no agota el timeout  <-- bug 0.7.3
//   3. Se respeta el silencio entre tramas
//   4. Una respuesta fragmentada en varios paquetes TCP se ensambla bien
//   5. El cliente revive tras un destroy + subscribe (deploy parcial)
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

// ── Utilidades RTU para fabricar respuestas ───────────────────────────────
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
    f[cuerpo.length] = c & 0xFF;
    f[cuerpo.length + 1] = (c >> 8) & 0xFF;
    return f;
}
function excepcion(slave, fc, codigo) {
    return conCRC(Buffer.from([slave, fc | 0x80, codigo]));
}
function respuestaRegistros(slave, valores) {
    const cuerpo = Buffer.alloc(3 + valores.length * 2);
    cuerpo[0] = slave; cuerpo[1] = 0x03; cuerpo[2] = valores.length * 2;
    valores.forEach((v, i) => cuerpo.writeUInt16BE(v & 0xFFFF, 3 + i * 2));
    return conCRC(cuerpo);
}
function ecoEscritura(slave, fc, reg, valor) {
    const cuerpo = Buffer.alloc(6);
    cuerpo[0] = slave; cuerpo[1] = fc;
    cuerpo.writeUInt16BE(reg, 2);
    cuerpo.writeUInt16BE(valor & 0xFFFF, 4);
    return conCRC(cuerpo);
}

// ── Esclavo simulado con modo configurable ────────────────────────────────
let modo = 'excepcion';
const tiemposPeticion = [];

const server = net.createServer(sock => {
    sock.on('data', req => {
        tiemposPeticion.push(Date.now());
        const slave = req[0], fc = req[1];
        if (modo === 'excepcion') {
            sock.write(excepcion(slave, fc, 0x02));
        } else if (modo === 'ok') {
            if (fc === 0x03) sock.write(respuestaRegistros(slave, [85, 170, 0, 0, 1, 215, 220]));
            else sock.write(ecoEscritura(slave, fc, req.readUInt16BE(2), req.readUInt16BE(4)));
        } else if (modo === 'fragmentado') {
            const full = respuestaRegistros(slave, [85, 170, 0, 0, 1, 215, 220]);
            sock.write(full.slice(0, 4));                       // primer trozo
            setTimeout(() => sock.write(full.slice(4)), 120);   // resto, tarde
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

server.listen(15020, '127.0.0.1', async () => {
    const node = Object.create(EventEmitter.prototype);
    RotClientCtor.call(node, {
        host: '127.0.0.1', port: 15020, timeout: 2, gap: 50, gapError: 300
    });

    console.log('\n── 1. Lectura rechazada por el esclavo ' + '─'.repeat(30));
    modo = 'excepcion';
    let t = Date.now(), err = null;
    try { await node.read(1, 3, 0, 10); } catch (e) { err = e; }
    let ms = Date.now() - t;
    comprobar('informa de excepcion Modbus', /Excepci/i.test(err && err.message),
        'mensaje recibido: "' + (err && err.message) + '"');
    comprobar('identifica el codigo 2 como direccion ilegal',
        /direccion de registro ilegal/i.test(err && err.message));
    comprobar('falla rapido (<500 ms), sin agotar el timeout', ms < 500, ms + ' ms');

    console.log('\n── 2. Escritura rechazada por el esclavo ' + '─'.repeat(28));
    t = Date.now(); err = null;
    try { await node.writeFC06(1, 6, 220); } catch (e) { err = e; }
    ms = Date.now() - t;
    comprobar('informa de excepcion Modbus', /Excepci/i.test(err && err.message),
        'mensaje recibido: "' + (err && err.message) + '"');
    comprobar('NO agota el timeout de 2 s  [regresion 0.7.3]', ms < 500, ms + ' ms');

    console.log('\n── 3. Silencio entre tramas ' + '─'.repeat(40));
    modo = 'ok';
    tiemposPeticion.length = 0;
    await Promise.all([
        node.read(1, 3, 0, 7),
        node.read(2, 3, 0, 7),
        node.read(3, 3, 0, 7)
    ]);
    const huecos = tiemposPeticion.slice(1).map((v, i) => v - tiemposPeticion[i]);
    comprobar('hay pausa >= 40 ms entre peticiones consecutivas',
        huecos.every(h => h >= 40), 'huecos medidos: ' + huecos.join(', ') + ' ms');

    console.log('\n── 4. Respuesta fragmentada en varios paquetes TCP ' + '─'.repeat(18));
    modo = 'fragmentado';
    let datos = null; err = null;
    try { datos = await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('ensambla los fragmentos sin error', !err, err && err.message);
    comprobar('decodifica los 7 registros con signo',
        datos && datos.decimal.length === 7 && datos.decimal[5] === 215,
        datos && JSON.stringify(datos.decimal));

    console.log('\n── 5. Revivir tras deploy parcial ' + '─'.repeat(34));
    modo = 'ok';
    node._queue.subscribe();
    node._queue.unsubscribe();          // suscriptores a 0 -> destroy() interno
    comprobar('destroy() marca el cliente como cerrado', node._queue._closed === true);
    node._queue.subscribe();            // vuelve un nodo tras el deploy
    comprobar('subscribe() reactiva la reconexion automatica  [regresion 0.7.3]',
        node._queue._closed === false);
    err = null;
    try { await node.read(1, 3, 0, 7); } catch (e) { err = e; }
    comprobar('vuelve a leer con normalidad', !err, err && err.message);

    console.log('\n' + '═'.repeat(70));
    console.log(fallos === 0
        ? '\x1b[32mTodas las pruebas pasan.\x1b[0m'
        : '\x1b[31m' + fallos + ' prueba(s) fallan.\x1b[0m');
    console.log('═'.repeat(70) + '\n');

    node._queue.destroy();
    server.close();
    process.exit(fallos === 0 ? 0 : 1);
});
