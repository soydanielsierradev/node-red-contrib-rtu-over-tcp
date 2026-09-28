module.exports = function (RED) {

    // ════════════════════════════════════════════════════════════════════════
    // TRES MODOS, UNA SOLA LOGICA
    //
    // Todas las variantes de Modbus comparten EXACTAMENTE la misma PDU (el
    // bloque [FC][datos...]). Lo unico que cambia es el envoltorio y el medio:
    //
    //   RTU over TCP : [slaveId] + PDU + [CRC_L][CRC_H]      por socket TCP
    //   Modbus RTU   : [slaveId] + PDU + [CRC_L][CRC_H]      por puerto serie
    //   Modbus TCP   : [tid][proto=0][len][unitId] + PDU     por socket TCP
    //                  (cabecera MBAP de 7 bytes, sin CRC)
    //
    // RTU over TCP y RTU serie son la MISMA trama: solo cambia el cable. Por
    // eso el codigo esta partido en capas:
    //   1. Constructores de PDU           -> comunes a todos los modos
    //   2. Envoltorio (wrap) y extraccion -> segun la trama (RTU / MBAP)
    //   3. Decodificadores de datos       -> comunes a todos los modos
    //   4. Transporte                     -> segun el medio (TCP / serie)
    // ════════════════════════════════════════════════════════════════════════

    // ── Utilidades RTU ────────────────────────────────────────────────────────

    function crc16(buf) {
        let crc = 0xFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc ^= buf[i];
            for (let j = 0; j < 8; j++)
                crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
        }
        return crc;
    }

    // Codigos de excepcion estandar. Un texto legible ahorra mucho tiempo:
    // "codigo=2" no dice nada, "direccion ilegal" apunta directo al registro.
    const EXCEPCIONES = {
        1: 'funcion no soportada por el esclavo',
        2: 'direccion de registro ilegal (registro inexistente en el equipo)',
        3: 'valor de dato ilegal (fuera del rango que acepta el registro)',
        4: 'fallo interno del esclavo',
        5: 'peticion aceptada, en curso (ACK)',
        6: 'esclavo ocupado, reintentar mas tarde',
        8: 'error de paridad en memoria',
        10: 'pasarela: ruta no disponible',
        11: 'pasarela: el equipo destino no responde'
    };

    function descExcepcion(fc, codigo) {
        const txt = EXCEPCIONES[codigo] || 'codigo desconocido';
        return 'Excepción Modbus FC=' + fc + ' código=' + codigo + ' (' + txt + ')';
    }

    // ════════════════════════════════════════════════════════════════════════
    // 1. CONSTRUCTORES DE PDU  (comunes a RTU over TCP y Modbus TCP)
    //    La PDU es [FC][datos...]: sin direccion de esclavo y sin CRC.
    // ════════════════════════════════════════════════════════════════════════

    // FC01 / FC02 / FC03 / FC04 — Read Coils / Discrete / Holding / Input
    function pduRead(fc, startReg, count) {
        const p = Buffer.alloc(5);
        p[0] = fc;
        p[1] = (startReg >> 8) & 0xFF; p[2] = startReg & 0xFF;
        p[3] = (count >> 8) & 0xFF;    p[4] = count & 0xFF;
        return p;
    }

    // FC05 — Write Single Coil
    function pduFC05(reg, value) {
        const v = (value === true || value === 1 || value === 0xFF00) ? 0xFF00 : 0x0000;
        const p = Buffer.alloc(5);
        p[0] = 0x05;
        p[1] = (reg >> 8) & 0xFF; p[2] = reg & 0xFF;
        p[3] = (v >> 8) & 0xFF;   p[4] = v & 0xFF;
        return p;
    }

    // FC06 — Write Single Register
    function pduFC06(reg, value) {
        const v = value & 0xFFFF;
        const p = Buffer.alloc(5);
        p[0] = 0x06;
        p[1] = (reg >> 8) & 0xFF; p[2] = reg & 0xFF;
        p[3] = (v >> 8) & 0xFF;   p[4] = v & 0xFF;
        return p;
    }

    // FC15 — Write Multiple Coils
    function pduFC15(reg, values) {
        const count     = values.length;
        const byteCount = Math.ceil(count / 8);
        const p         = Buffer.alloc(6 + byteCount);
        p[0] = 0x0F;
        p[1] = (reg >> 8) & 0xFF;   p[2] = reg & 0xFF;
        p[3] = (count >> 8) & 0xFF; p[4] = count & 0xFF;
        p[5] = byteCount;
        for (let i = 0; i < count; i++)
            if (values[i]) p[6 + Math.floor(i / 8)] |= (1 << (i % 8));
        return p;
    }

    // FC16 — Write Multiple Registers
    function pduFC16(reg, values) {
        const count     = values.length;
        const byteCount = count * 2;
        const p         = Buffer.alloc(6 + byteCount);
        p[0] = 0x10;
        p[1] = (reg >> 8) & 0xFF;   p[2] = reg & 0xFF;
        p[3] = (count >> 8) & 0xFF; p[4] = count & 0xFF;
        p[5] = byteCount;
        for (let i = 0; i < count; i++) {
            const v = values[i] & 0xFFFF;
            p[6 + i * 2] = (v >> 8) & 0xFF;
            p[7 + i * 2] = v & 0xFF;
        }
        return p;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 2. ENVOLTORIO DE TRAMA
    // ════════════════════════════════════════════════════════════════════════

    // RTU over TCP: [slaveId] + PDU + CRC16 (little endian)
    function wrapRTU(deviceId, pdu) {
        const f = Buffer.alloc(1 + pdu.length + 2);
        f[0] = deviceId;
        pdu.copy(f, 1);
        const c = crc16(f.slice(0, 1 + pdu.length));
        f[1 + pdu.length] = c & 0xFF;
        f[2 + pdu.length] = (c >> 8) & 0xFF;
        return f;
    }

    // Modbus TCP: cabecera MBAP + PDU, sin CRC (la integridad la garantiza TCP)
    //   bytes 0-1 : Transaction ID  — el esclavo lo devuelve tal cual; sirve
    //               para emparejar peticion y respuesta
    //   bytes 2-3 : Protocol ID     — siempre 0 para Modbus
    //   bytes 4-5 : Length          — bytes que siguen: unitId + PDU
    //   byte  6   : Unit ID         — el esclavo; en equipos TCP nativos suele
    //               ignorarse (se pone 1 o 255), en pasarelas TCP→RTU es el
    //               slave id real del bus serie
    function wrapTCP(tid, deviceId, pdu) {
        const f = Buffer.alloc(7 + pdu.length);
        f.writeUInt16BE(tid & 0xFFFF, 0);
        f.writeUInt16BE(0, 2);
        f.writeUInt16BE(pdu.length + 1, 4);
        f[6] = deviceId;
        pdu.copy(f, 7);
        return f;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3. DECODIFICADORES DE DATOS  (comunes a los dos protocolos)
    //    Reciben SOLO el area de datos, ya recortada del frame.
    // ════════════════════════════════════════════════════════════════════════

    // FC01/FC02 — bits empaquetados: bit0 = coil[0], bit1 = coil[1], etc.
    function decodeCoils(data, count) {
        const decimal = [], hex = [];
        for (let i = 0; i < count; i++) {
            const bit = (data[Math.floor(i / 8)] >> (i % 8)) & 1;
            decimal[i] = bit;
            hex[i]     = bit ? '0x0001' : '0x0000';
        }
        return { decimal, hex };
    }

    // FC03/FC04 — registros de 16 bits con signo
    function decodeRegisters(data, count) {
        const decimal = [], hex = [];
        for (let i = 0; i < count; i++) {
            const raw    = (data[i * 2] << 8) | data[i * 2 + 1];
            const signed = raw < 32768 ? raw : raw - 65536;
            decimal[i]   = signed;
            hex[i]       = '0x' + raw.toString(16).toUpperCase().padStart(4, '0');
        }
        return { decimal, hex };
    }

    // Bytes que ocupa el area de datos de una lectura, segun el FC
    function bytesDeDatos(fc, count) {
        return (fc === 1 || fc === 2) ? Math.ceil(count / 8) : count * 2;
    }

    // ── Parsers RTU (trabajan sobre el frame COMPLETO, con CRC) ───────────────

    // FC01/FC02 — Read Coils / Read Discrete Inputs
    // Respuesta: [devId][FC][byteCount][bits empaquetados...][CRC_L][CRC_H]
    function parseCoilResponse(buf, count) {
        const byteCount = Math.ceil(count / 8);
        const expected  = 3 + byteCount + 2;
        // La EXCEPCION se comprueba ANTES que la longitud: una excepcion Modbus
        // son 5 bytes y siempre sera "mas corta" que la trama esperada. Si se
        // mira la longitud primero, el error real queda enmascarado como
        // "Respuesta corta" y el diagnostico se vuelve imposible.
        if (buf.length >= 3 && (buf[1] & 0x80))
            throw new Error(descExcepcion(buf[1] & 0x7F, buf[2]));
        if (buf.length < expected)
            throw new Error('Respuesta corta: ' + buf.length + ' bytes, esperados ' + expected);
        const rxCRC = buf[expected - 2] | (buf[expected - 1] << 8);
        if (rxCRC !== crc16(buf.slice(0, expected - 2)))
            throw new Error('CRC inválido en respuesta de lectura de coils');
        const r = decodeCoils(buf.slice(3), count);
        return { decimal: r.decimal, hex: r.hex, expectedBytes: expected };
    }

    // FC03/FC04 — Read Holding/Input Registers
    // Respuesta: [devId][FC][byteCount][val0H][val0L]...[CRC_L][CRC_H]
    function parseRegisterResponse(buf, count) {
        const expected = 3 + count * 2 + 2;
        if (buf.length >= 3 && (buf[1] & 0x80))
            throw new Error(descExcepcion(buf[1] & 0x7F, buf[2]));
        if (buf.length < expected)
            throw new Error('Respuesta corta: ' + buf.length + ' bytes, esperados ' + expected);
        const rxCRC = buf[expected - 2] | (buf[expected - 1] << 8);
        if (rxCRC !== crc16(buf.slice(0, expected - 2)))
            throw new Error('CRC inválido en respuesta de lectura de registros');
        const r = decodeRegisters(buf.slice(3), count);
        return { decimal: r.decimal, hex: r.hex, expectedBytes: expected };
    }

    // Router: elige el parser correcto según FC
    function parseReadResponse(buf, fc, count) {
        if (fc === 1 || fc === 2) return parseCoilResponse(buf, count);
        return parseRegisterResponse(buf, count);
    }

    function parseWriteResponse(buf, fc) {
        if (buf.length >= 3 && (buf[1] & 0x80))
            throw new Error(descExcepcion(buf[1] & 0x7F, buf[2]));
        if (buf.length < 8)
            throw new Error('Respuesta corta: ' + buf.length + ' bytes, esperados 8');
        const rxCRC = buf[6] | (buf[7] << 8);
        if (rxCRC !== crc16(buf.slice(0, 6)))
            throw new Error('CRC inválido en respuesta de escritura');
        const reg = (buf[2] << 8) | buf[3];
        if (fc === 0x05 || fc === 0x06)
            return { reg, value: (buf[4] << 8) | buf[5], expectedBytes: 8 };
        return { reg, count: (buf[4] << 8) | buf[5], expectedBytes: 8 };
    }

    // ── Parsers Modbus TCP (trabajan sobre la PDU: sin MBAP y sin CRC) ────────
    //
    // No hay CRC que validar: la cabecera MBAP ya trae la longitud exacta y TCP
    // garantiza la integridad. A cambio conviene ser estricto con el FC y el
    // byteCount, que son las unicas comprobaciones de coherencia que quedan.

    function parsePduRead(pdu, fc, count) {
        if (pdu.length >= 2 && (pdu[0] & 0x80))
            throw new Error(descExcepcion(pdu[0] & 0x7F, pdu[1]));
        if (pdu.length < 2)
            throw new Error('PDU corta: ' + pdu.length + ' bytes');
        if (pdu[0] !== fc)
            throw new Error('Función inesperada en la respuesta: FC=' + pdu[0] + ', se pidió FC=' + fc);

        const esperados = bytesDeDatos(fc, count);
        const byteCount = pdu[1];
        if (byteCount !== esperados)
            throw new Error('byteCount incoherente: ' + byteCount + ' bytes, esperados ' + esperados);
        if (pdu.length < 2 + byteCount)
            throw new Error('PDU incompleta: ' + pdu.length + ' bytes, esperados ' + (2 + byteCount));

        const data = pdu.slice(2, 2 + byteCount);
        const r = (fc === 1 || fc === 2) ? decodeCoils(data, count) : decodeRegisters(data, count);
        return { decimal: r.decimal, hex: r.hex };
    }

    function parsePduWrite(pdu, fc) {
        if (pdu.length >= 2 && (pdu[0] & 0x80))
            throw new Error(descExcepcion(pdu[0] & 0x7F, pdu[1]));
        if (pdu.length < 5)
            throw new Error('PDU corta en respuesta de escritura: ' + pdu.length + ' bytes, esperados 5');
        if (pdu[0] !== fc)
            throw new Error('Función inesperada en la respuesta: FC=' + pdu[0] + ', se pidió FC=' + fc);
        const reg = (pdu[1] << 8) | pdu[2];
        if (fc === 0x05 || fc === 0x06)
            return { reg, value: (pdu[3] << 8) | pdu[4] };
        return { reg, count: (pdu[3] << 8) | pdu[4] };
    }

    // ════════════════════════════════════════════════════════════════════════
    // Utilidades del puerto serie
    // ════════════════════════════════════════════════════════════════════════

    // 'serialport' es dependencia OPCIONAL y se carga solo cuando un cliente
    // usa el modo serie: quien trabaje solo por TCP no necesita el modulo
    // nativo, y si su compilacion falla en alguna plataforma rara, el resto
    // del paquete sigue funcionando.
    function cargarSerialPort() {
        try {
            return require('serialport').SerialPort;
        } catch (e) {
            const err = new Error('Falta el módulo "serialport". Instálalo en el directorio ' +
                'de usuario de Node-RED (~/.node-red) con: npm install serialport');
            err.fatal = true;
            throw err;
        }
    }

    // t3.5 del estandar Modbus RTU: 3,5 caracteres de 11 bits. Por encima de
    // 19200 baudios el estandar lo fija en 1,75 ms.
    function t35ms(baudios) {
        return baudios > 19200 ? 1.75 : (3.5 * 11 * 1000) / baudios;
    }

    // Los errores del SO son poco claros ("Error: Error: Resource temporarily
    // unavailable Cannot lock port"). Se traducen a algo accionable.
    function traducirErrorSerie(err, ruta) {
        const m = String(err && err.message || err);
        if (/No such file|ENOENT|cannot find|File not found/i.test(m))
            return 'Puerto no encontrado · ' + ruta + ' (¿adaptador desconectado?)';
        if (/Permission denied|EACCES|Access denied/i.test(m))
            return 'Sin permiso sobre ' + ruta + ' (Linux: añade el usuario de Node-RED al grupo dialout)';
        if (/lock|busy|temporarily unavailable|EBUSY/i.test(m))
            return 'Puerto ocupado · ' + ruta + ' (lo usa otro proceso u otro cliente)';
        return m + ' · ' + ruta;
    }

    // ════════════════════════════════════════════════════════════════════════
    // ModbusQueue — cola serializada sobre un enlace persistente
    //
    // Dos ejes independientes:
    //   transporte : 'tcp' (socket)       | 'serial' (puerto serie local)
    //   trama      : 'rtu' (slave + CRC)  | 'mbap'   (cabecera Modbus TCP)
    //
    //   Modo del panel     transporte   trama
    //   ─────────────────  ───────────  ──────
    //   RTU over TCP       tcp          rtu
    //   Modbus TCP         tcp          mbap
    //   Modbus RTU serie   serial       rtu
    //
    // Un único enlace compartido entre todos los nodos que usen este cliente.
    // Las peticiones se encolan y se envían de una en una para evitar
    // colisiones en el bus RS485 y para no depender de que el esclavo TCP
    // soporte transacciones concurrentes (muchos equipos no).
    // ════════════════════════════════════════════════════════════════════════
    class ModbusQueue {
        // opts = { protocol, host, port, serial:{path,baudRate,dataBits,parity,stopBits,echo},
        //          timeout, gapMs, gapErrMs, onStatus }
        constructor(opts) {
            this.timeout  = opts.timeout;    // ms
            this.onStatus = opts.onStatus;   // (fill, shape, text) => {}

            // Modo -> (transporte, trama). 'rtu' es el valor historico y el
            // que se asume en configuraciones antiguas sin este campo.
            const modo = opts.protocol;
            this.protocol   = (modo === 'tcp' || modo === 'serial') ? modo : 'rtu';
            this.transporte = this.protocol === 'serial' ? 'serial' : 'tcp';
            this.trama      = this.protocol === 'tcp'    ? 'mbap'   : 'rtu';

            this.host   = opts.host;
            this.port   = opts.port;
            this.serial = opts.serial || {};

            // Silencio entre tramas. 50 ms cubre el t3.5 de sobra a 9600 baudios
            // y sigue permitiendo un sondeo rapido; subelo si el bus es largo,
            // tiene muchos slaves o el gateway es lento. En Modbus TCP nativo no
            // hay bus serie que drenar y lo normal es dejarlo en 0.
            this.gapMs    = opts.gapMs    !== undefined ? opts.gapMs    : 50;
            this.gapErrMs = opts.gapErrMs !== undefined ? opts.gapErrMs : 500;

            // En serie el silencio NUNCA puede bajar del t3.5 real del bus: con
            // un gap de 0 el esclavo veria dos peticiones como una sola trama.
            if (this.transporte === 'serial') {
                const minimo = Math.ceil(t35ms(this.serial.baudRate || 9600));
                this.gapMs    = Math.max(this.gapMs,    minimo);
                this.gapErrMs = Math.max(this.gapErrMs, minimo);
            }

            this._socket         = null;   // net.Socket o SerialPort
            this._rxBuf          = Buffer.alloc(0);
            this._queue          = [];
            this._active         = null;
            this._closed         = false;
            this._connecting     = false;
            this._reconnectTimer = null;
            this._gapTimer       = null;
            this._lastFallo      = false;
            this._subscribers    = 0;      // nodos conectados a este cliente
            this._tid            = 0;      // Transaction ID (solo Modbus TCP)
            this._cierre         = null;   // promesa del cierre fisico en curso
        }

        // Transaction ID incremental, 1..65535. Se evita el 0 para que un
        // buffer a ceros nunca "coincida" por accidente con la peticion viva.
        _nextTid() {
            this._tid = (this._tid % 0xFFFF) + 1;
            return this._tid;
        }

        get etiquetaProto() {
            if (this.protocol === 'tcp')    return 'Modbus TCP';
            if (this.protocol === 'serial') return 'RTU serie';
            return 'RTU over TCP';
        }

        get destino() {
            if (this.transporte === 'serial') {
                const s = this.serial;
                const paridad = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[s.parity] || 'N';
                return s.path + ' · ' + s.baudRate + ' ' + s.dataBits + paridad + s.stopBits;
            }
            return this.host + ':' + this.port;
        }

        _enlaceVivo() {
            return !!(this._socket && !this._socket.destroyed);
        }

        // ── Conexión ──────────────────────────────────────────────────────────
        _connect() {
            if (this._enlaceVivo()) return;
            if (this._connecting) return;
            this._connecting = true;
            if (this.transporte === 'serial') this._abrirSerie();
            else                              this._abrirTcp();
        }

        _abrirTcp() {
            const net    = require('net');
            const socket = new net.Socket();
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 5000);
            // Sin esta llamada el handler 'timeout' de mas abajo era codigo
            // muerto: nunca disparaba. Detecta el gateway que mantiene el socket
            // abierto pero deja de contestar (medio-abierto), caso que el
            // keepalive del SO puede tardar minutos en descubrir.
            socket.setTimeout(Math.max(this.timeout * 3, 30000));

            socket.connect({ host: this.host, port: this.port }, () => {
                this._connecting = false;
                this._socket     = socket;
                this._rxBuf      = Buffer.alloc(0);
                this.onStatus('green', 'dot', 'conectado · ' + this.destino + ' · ' + this.etiquetaProto);
                this._flush();
            });

            socket.on('data', chunk => this._alRecibir(chunk));

            socket.on('error', err => {
                const codes = {
                    ECONNREFUSED: 'Conexión rechazada · ' + this.host + ':' + this.port,
                    EHOSTUNREACH: 'Host inalcanzable · ' + this.host,
                    ETIMEDOUT:    'Timeout TCP · '        + this.host + ':' + this.port,
                    ENOTFOUND:    'Host no encontrado · ' + this.host,
                    EACCES:       'Acceso denegado · '    + this.host + ':' + this.port,
                };
                this._handleDisconnect(new Error(codes[err.code] || err.message));
            });

            socket.on('close',   () => { if (!this._closed) this._handleDisconnect(new Error('Conexión cerrada por el remoto')); });
            socket.on('timeout', () => socket.destroy(new Error('Timeout de socket')));

            this._socket = socket;
        }

        _abrirSerie() {
            let SerialPort;
            try {
                SerialPort = cargarSerialPort();
            } catch (e) {
                this._handleDisconnect(e);
                return;
            }

            const s = this.serial;
            let puerto;
            try {
                puerto = new SerialPort({
                    path:     s.path,
                    baudRate: s.baudRate,
                    dataBits: s.dataBits,
                    parity:   s.parity,
                    stopBits: s.stopBits,
                    autoOpen: false
                });
            } catch (e) {
                // Opciones invalidas (ruta vacia, baudios raros...): no tiene
                // sentido reintentar cada 2 s con la misma configuracion. La
                // marca va en el error que se PROPAGA, no en el original.
                const fatal = new Error('Configuración serie inválida: ' + e.message);
                fatal.fatal = true;
                this._handleDisconnect(fatal);
                return;
            }
            puerto._rotSerie  = true;
            puerto._abriendo  = true;
            puerto._alLiberar = null;   // lo fija _soltarEnlace si cierra a mitad
            this._socket = puerto;

            puerto.open(err => {
                puerto._abriendo = false;
                // Si mientras se abria el cliente se cerro o se reemplazo el
                // puerto, este ya no es nuestro: cerrarlo para no dejar el
                // descriptor abierto y el lock tomado, y AVISAR a quien espera
                // el cierre solo cuando el puerto este liberado de verdad.
                if (this._socket !== puerto) {
                    const liberado = () => { if (puerto._alLiberar) puerto._alLiberar(); };
                    if (!err && puerto.isOpen) puerto.close(() => liberado());
                    else liberado();
                    return;
                }
                if (err) {
                    this._handleDisconnect(new Error(traducirErrorSerie(err, s.path)));
                    return;
                }
                this._connecting = false;
                this._rxBuf      = Buffer.alloc(0);
                this.onStatus('green', 'dot', 'abierto · ' + this.destino + ' · ' + this.etiquetaProto);
                this._flush();
            });

            puerto.on('data',  chunk => this._alRecibir(chunk));
            puerto.on('error', err   => this._handleDisconnect(new Error(traducirErrorSerie(err, s.path))));
            // 'close' con error = adaptador USB arrancado en caliente
            puerto.on('close', err   => {
                if (this._closed) return;
                this._handleDisconnect(new Error(err && err.disconnected
                    ? 'Puerto serie desconectado · ' + s.path
                    : 'Puerto serie cerrado · ' + s.path));
            });
        }

        _alRecibir(chunk) {
            this._rxBuf = Buffer.concat([this._rxBuf, chunk]);
            this._tryParse();
        }

        // Suelta el enlace actual y devuelve una promesa que se cumple cuando
        // el recurso fisico esta liberado de verdad.
        //
        // IMPORTANTE en serie: SerialPort.destroy() NO cierra el puerto (el
        // stream no implementa _destroy), dejaria el descriptor y el lock del
        // SO tomados, y el siguiente open() fallaria con "Cannot lock port".
        // Hay que usar close(). Y hay que ESPERARLO: en un deploy, el cliente
        // nuevo abre la misma ruta nada mas cerrarse el viejo.
        _soltarEnlace() {
            const s = this._socket;
            this._socket = null;
            if (!s) return Promise.resolve();
            s.removeAllListeners();
            // Un error tardio durante el cierre no debe tumbar Node-RED por
            // quedarse sin listener.
            s.on('error', () => {});

            return new Promise(resolve => {
                // Red de seguridad para no bloquear un deploy si el SO nunca
                // contesta. Holgada: un open()+close() serie tarda milisegundos.
                const guarda = setTimeout(resolve, 3000);
                const listo  = () => { clearTimeout(guarda); resolve(); };
                if (s._rotSerie) {
                    if (s._abriendo) {
                        // open() en curso: aun no se puede cerrar. Su callback
                        // lo cerrara (ya no es el puerto activo) y llamara a
                        // listo() al terminar. Resolver ahora daria el puerto
                        // por libre cuando todavia esta a medio abrir.
                        s._alLiberar = listo;
                    } else if (s.isOpen) {
                        s.close(() => listo());
                    } else {
                        listo();
                    }
                } else {
                    if (s.destroyed) listo();
                    else { s.once('close', listo); s.destroy(); }
                }
            });
        }

        _handleDisconnect(err) {
            this._cierre     = this._soltarEnlace();
            this._connecting = false;
            this._rxBuf      = Buffer.alloc(0);

            if (this._active) {
                clearTimeout(this._active.timer);
                this._active.reject(err);
                this._active = null;
            }

            // Lo encolado tambien falla YA. El timeout de cada peticion solo
            // arranca al enviarla, asi que sin enlace se quedaba esperando sin
            // limite: con un rot-read en polling la cola crecia mientras el
            // equipo estaba caido y al reconectar salia una rafaga de lecturas
            // viejas. Mejor que cada disparo reciba su error por la salida 3.
            this._queue.forEach(r => r.reject(err));
            this._queue = [];

            // Error sin arreglo reintentando (falta el modulo, config invalida):
            // no se programa reconexion.
            if (err.fatal) {
                if (!this._closed) this.onStatus('red', 'ring', err.message);
                return;
            }

            if (this._closed) return;
            this.onStatus('red', 'ring', err.message);

            // Reconexion automatica mientras haya nodos suscritos. Si el socket
            // caia estando el bus en reposo y nadie reconectaba, la primera
            // lectura posterior se comia un timeout entero.
            if (this._subscribers > 0 && !this._reconnectTimer) {
                this._reconnectTimer = setTimeout(() => {
                    this._reconnectTimer = null;
                    if (!this._closed) this._connect();
                }, 2000);
            }
        }

        // ── Cola ──────────────────────────────────────────────────────────────
        _flush() {
            if (this._active || this._queue.length === 0) return;
            // Si hay un silencio en curso, NO adelantarlo: una peticion nueva que
            // entre por enqueue() durante el gap no debe pisar la linea antes de
            // tiempo. El propio temporizador del gap llamara a _flush al vencer.
            if (this._gapTimer) return;
            if (!this._enlaceVivo()) { this._connect(); return; }
            if (this._connecting) return;   // el callback de connect hara el flush

            const req    = this._queue.shift();
            this._active = req;
            this._rxBuf  = Buffer.alloc(0);

            // El frame se construye AQUI, no al encolar: en Modbus TCP el
            // Transaction ID debe ser el del envio real. Si se fijara al
            // encolar, un reintento tras reconexion reutilizaria un TID viejo y
            // una respuesta rezagada podria colarse como valida.
            let frame;
            if (this.trama === 'mbap') {
                req.tid = this._nextTid();
                frame   = wrapTCP(req.tid, req.deviceId, req.pdu);
            } else {
                frame   = wrapRTU(req.deviceId, req.pdu);
            }

            // ECO LOCAL. Muchos adaptadores USB-RS485 baratos (y algunos HATs
            // de Raspberry) devuelven por RX lo que transmiten. El eco empieza
            // por [slave][fc] igual que la respuesta real, asi que la
            // resincronizacion lo tomaria por bueno y daria CRC invalido. Con
            // la opcion activada se descartan exactamente esos bytes.
            req.eco = (this.transporte === 'serial' && this.serial.echo) ? frame.length : 0;

            req.timer = setTimeout(() => {
                this._active = null;
                // Descarta cualquier byte parcial de la peticion que expiro: una
                // respuesta tardia no debe mezclarse con la siguiente lectura.
                this._rxBuf  = Buffer.alloc(0);
                this._lastFallo = true;
                req.reject(new Error('Timeout (' + (this.timeout / 1000).toFixed(1) + 's) sin respuesta'));
                this._scheduleFlush(this.gapErrMs);
            }, this.timeout);

            try {
                this._socket.write(frame);
            } catch (e) {
                clearTimeout(req.timer);
                this._active = null;
                req.reject(new Error('Error al enviar frame: ' + e.message));
                this._flush();
            }
        }

        _tryParse() {
            if (!this._active) return;
            if (this.trama === 'mbap') this._tryParseTCP();
            else                       this._tryParseRTU();
        }

        // ── Recepción Modbus TCP ──────────────────────────────────────────────
        //
        // Aqui la vida es mucho mas facil que en RTU: la cabecera MBAP dice
        // exactamente cuantos bytes ocupa la respuesta, asi que el troceado es
        // determinista y no hay que deducir nada del byteCount.
        //
        // Y el Transaction ID resuelve de raiz el problema de las respuestas
        // tardias: en vez de descartar byte a byte buscando una cabecera
        // plausible (lo que hace el modo RTU), se descarta la TRAMA ENTERA cuyo
        // TID no coincide con el de la peticion en curso.
        _tryParseTCP() {
            const req = this._active;

            for (;;) {
                if (this._rxBuf.length < 6) return;   // ni siquiera la cabecera

                const tid   = this._rxBuf.readUInt16BE(0);
                const proto = this._rxBuf.readUInt16BE(2);
                const len   = this._rxBuf.readUInt16BE(4);

                // Cabecera imposible: el flujo esta desalineado o el equipo no
                // habla Modbus TCP (tipico si se apunta un cliente TCP a un
                // gateway RTU over TCP o al reves). Vaciar y fallar rapido es
                // mejor que arrastrar basura hasta agotar el timeout.
                if (proto !== 0 || len < 2 || len > 253) {
                    this._rxBuf = Buffer.alloc(0);
                    this._resolver(req, () => {
                        throw new Error('Cabecera MBAP inválida (protocolo=' + proto + ', longitud=' + len +
                            '). ¿El equipo habla RTU over TCP en vez de Modbus TCP?');
                    });
                    return;
                }

                const total = 6 + len;
                if (this._rxBuf.length < total) return;   // respuesta fragmentada

                const frame = this._rxBuf.slice(0, total);
                this._rxBuf = this._rxBuf.slice(total);

                if (tid !== req.tid) {
                    // Respuesta rezagada de una transaccion anterior. Se tira
                    // entera y se sigue mirando lo que quede en el buffer.
                    this._staleCount = (this._staleCount || 0) + 1;
                    console.log('[MODBUS-TCP] descartada respuesta rezagada #' + this._staleCount +
                        ' (TID ' + tid + ', esperado ' + req.tid + ')');
                    continue;
                }

                const unitId = frame[6];
                const pdu    = frame.slice(7);

                this._resolver(req, () => {
                    // El unit id que devuelve el esclavo deberia ser el que
                    // pedimos. Muchos equipos TCP nativos lo ignoran, asi que
                    // esto solo avisa: no invalida la respuesta.
                    if (unitId !== req.deviceId)
                        console.log('[MODBUS-TCP] aviso: unitId ' + unitId +
                            ' en la respuesta, se pidió ' + req.deviceId);
                    return req.parsePdu(pdu);
                });
                return;
            }
        }

        // Cierra la transaccion en curso: resuelve o rechaza y programa el
        // silencio que corresponda. Comun a los dos protocolos.
        _resolver(req, ejecutarParse) {
            this._active = null;
            clearTimeout(req.timer);
            try {
                const result = ejecutarParse();
                this._lastFallo = false;
                req.resolve(result);
            } catch (e) {
                this._lastFallo = true;
                req.reject(e);
            }
            this._scheduleFlush(this._lastFallo ? this.gapErrMs : this.gapMs);
        }

        // ── Recepción RTU (over TCP o serie) ──────────────────────────────────
        _tryParseRTU() {
            const req = this._active;

            // Descartar el eco local de nuestra propia peticion (solo serie, y
            // solo si esta activada la opcion). Puede llegar troceado.
            if (req.eco > 0) {
                const n = Math.min(req.eco, this._rxBuf.length);
                this._rxBuf = this._rxBuf.slice(n);
                req.eco -= n;
                if (req.eco > 0 || this._rxBuf.length === 0) return;
            }

            // RESINCRONIZACION DE TRAMA.
            //
            // RTU over TCP no lleva transaction ID, asi que una respuesta TARDIA
            // de una peticion anterior (que expiro o fallo) puede llegar justo
            // despues de enviar la siguiente y colocarse al principio del buffer.
            // Si la parseamos a ciegas, su cabecera se toma como la de la
            // respuesta actual: buf[2] da un byteCount que no corresponde y el
            // CRC falla. Ese es el origen de los CRC sueltos y aparentemente
            // aleatorios, mas frecuentes cuantos mas slaves hay en el bus.
            //
            // Aqui descartamos byte a byte hasta encontrar una cabecera que
            // coincida con LO QUE PEDIMOS (slave + funcion, normal o excepcion).
            if (req.deviceId !== undefined && req.fc !== undefined) {
                let desc = 0;
                while (this._rxBuf.length >= 2) {
                    const okSlave = this._rxBuf[0] === req.deviceId;
                    const okFc    = this._rxBuf[1] === req.fc ||
                                    this._rxBuf[1] === (req.fc | 0x80);
                    if (okSlave && okFc) break;
                    this._rxBuf = this._rxBuf.slice(1);
                    desc++;
                }
                if (desc > 0) {
                    this._resyncCount = (this._resyncCount || 0) + 1;
                    // Visible en el log de Node-RED. Si ves estas lineas, confirma
                    // que habia respuestas tardias contaminando el buffer: cada
                    // una de ellas habria sido un CRC invalido antes de este fix.
                    console.log('[RTU] resync #' + this._resyncCount + ': descartados ' +
                        desc + ' byte(s) desalineados (slave esperado ' + req.deviceId + ')');
                }
                // Si no queda nada utilizable, esperamos a mas datos.
                if (this._rxBuf.length < 2) return;
            }

            // ── EXCEPCION MODBUS ──────────────────────────────────────────────
            // [slave][fc|0x80][codigo][CRC][CRC] = 5 bytes, para CUALQUIER tipo
            // de peticion. Se comprueba ANTES del corte por minBytes porque las
            // escrituras se encolan con minBytes=8: al ser la excepcion de solo
            // 5 bytes, antes se descartaba en silencio y la peticion agotaba el
            // timeout completo pese a haber recibido respuesta. Ese era el
            // origen de los "timeouts" tras escrituras rechazadas.
            const esExcepcion = this._rxBuf.length >= 2 && (this._rxBuf[1] & 0x80) !== 0;

            if (esExcepcion) {
                if (this._rxBuf.length < 5) return;   // aun no llega completa
            } else {
                // Esperar al menos la cantidad mínima de bytes según el tipo
                if (this._rxBuf.length < req.minBytes) return;

                // Para lecturas hay que esperar a tener la trama COMPLETA. El
                // gateway puede fragmentar la respuesta en varios paquetes TCP,
                // asi que no basta con minBytes: hay que aguardar al tamano real.
                if (req.type === 'read') {
                    // Respuesta normal: esperamos el tamano que ESPERA la peticion.
                    // Se acota porTrama porque buf[2] puede venir corrupto: sin
                    // el limite, un byteCount basura (p.ej. 0xFF) haria esperar
                    // 260 bytes que no llegaran nunca y forzaria un timeout.
                    const porPeticion = req.expectedLen || 0;
                    const byteCount   = this._rxBuf[2];
                    const porTrama    = (byteCount > 0 && byteCount <= 250) ? 3 + byteCount + 2 : 0;
                    const expected    = Math.max(porPeticion, porTrama);
                    if (this._rxBuf.length < expected) return;   // sigue fragmentada
                }
            }

            this._active = null;
            clearTimeout(req.timer);

            try {
                const result = req.parseRtu(this._rxBuf);
                this._rxBuf  = this._rxBuf.slice(result.expectedBytes);
                this._lastFallo = false;
                req.resolve(result);
            } catch (e) {
                this._lastFallo = true;
                // Trama corrupta (CRC invalido, bytes de mas/menos). Hay que
                // DESCARTAR el buffer entero: si dejamos los bytes sobrantes,
                // la siguiente lectura los interpreta como su cabecera, buf[2]
                // da un byteCount basura y arrastra el fallo en cadena. Vaciar
                // aqui rompe ese efecto domino y realinea el socket.
                this._rxBuf = Buffer.alloc(0);
                req.reject(e);
            }

            // SILENCIO ENTRE TRAMAS (t3.5). En RS-485 el esclavo necesita soltar
            // la linea antes de que llegue la siguiente peticion; encadenar
            // transacciones sin pausa produce CRC intermitentes que parecen
            // aleatorios. El gap es mayor tras un fallo para dejar drenar el bus.
            this._scheduleFlush(this._lastFallo ? this.gapErrMs : this.gapMs);
        }

        // Lanza la siguiente transaccion tras el silencio obligatorio.
        _scheduleFlush(ms) {
            if (this._gapTimer) clearTimeout(this._gapTimer);
            // Con gap 0 (tipico en Modbus TCP nativo) no se programa timer: se
            // encadena en el siguiente tick para no bloquear el event loop ni
            // meter un retardo de ~1 ms por transaccion.
            if (!ms || ms <= 0) {
                this._gapTimer = null;
                setImmediate(() => this._flush());
                return;
            }
            this._gapTimer = setTimeout(() => {
                this._gapTimer = null;
                this._flush();
            }, ms);
        }

        // ── API pública ───────────────────────────────────────────────────────

        // req = { pdu, deviceId, fc, type, minBytes, expectedLen, parseRtu, parsePdu }
        enqueue(req) {
            return new Promise((resolve, reject) => {
                this._queue.push(Object.assign(
                    { minBytes: 5, expectedLen: 0, timer: null, tid: 0 },
                    req,
                    { resolve, reject }
                ));
                this._connect();
                if (this._enlaceVivo() && !this._connecting)
                    this._flush();
            });
        }

        // Registrar / liberar un nodo suscriptor
        // Un deploy parcial puede llevar los suscriptores a 0 (destroy() marca
        // _closed) y volver a subirlos. Sin reponer el flag, el cliente reconecta
        // pero se queda SIN reconexion automatica para siempre: _handleDisconnect
        // sale antes de reprogramar nada. Aqui lo revivimos.
        subscribe()   { this._subscribers++; this._closed = false; }
        unsubscribe() {
            this._subscribers--;
            if (this._subscribers <= 0) this.destroy();
        }

        // Devuelve una promesa que se cumple cuando el enlace fisico queda
        // liberado. Llamarla dos veces (unsubscribe + close del nodo) devuelve
        // el mismo cierre pendiente en vez de darlo por hecho antes de tiempo.
        destroy() {
            this._closed = true;
            this._connecting = false;
            if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
            if (this._gapTimer) { clearTimeout(this._gapTimer); this._gapTimer = null; }
            if (this._active) { clearTimeout(this._active.timer); this._active.reject(new Error('Cliente cerrado')); this._active = null; }
            this._queue.forEach(r => r.reject(new Error('Cliente cerrado')));
            this._queue = [];
            if (this._socket) this._cierre = this._soltarEnlace();
            return this._cierre || Promise.resolve();
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Listado de puertos serie para el editor
    // ════════════════════════════════════════════════════════════════════════

    function hayEjecutable(nombre) {
        const fs   = require('fs');
        const path = require('path');
        return (process.env.PATH || '').split(path.delimiter)
            .some(dir => dir && fs.existsSync(path.join(dir, nombre)));
    }

    async function listarPuertos() {
        const fs = require('fs');
        const vistos = new Map();   // ruta -> { path, info }

        // 1) Nombres ESTABLES primero. /dev/ttyUSB0 puede pasar a ser ttyUSB1
        //    tras un reinicio o al enchufar otro adaptador; la ruta by-id
        //    identifica al adaptador concreto y no cambia nunca.
        if (process.platform === 'linux') {
            try {
                for (const f of fs.readdirSync('/dev/serial/by-id')) {
                    const ruta = '/dev/serial/by-id/' + f;
                    let real = '';
                    try { real = fs.realpathSync(ruta); } catch (e) { /* enlace roto */ }
                    vistos.set(ruta, { path: ruta, info: 'estable' + (real ? ' → ' + real : '') });
                }
            } catch (e) { /* no hay adaptadores USB */ }
            for (const alias of ['/dev/serial0', '/dev/serial1']) {   // Raspberry Pi
                if (fs.existsSync(alias)) vistos.set(alias, { path: alias, info: 'UART Raspberry Pi' });
            }
        }

        // 2) Listado de serialport. En Linux depende de 'udevadm': si no existe
        //    (contenedores Docker, Alpine) el modulo lanza una excepcion NO
        //    capturable al hacer spawn y tumbaria Node-RED entero. Por eso se
        //    comprueba antes y, si falta, se escanea /dev a mano.
        let SerialPort = null;
        try { SerialPort = require('serialport').SerialPort; } catch (e) { /* no instalado */ }
        const listadoSeguro = SerialPort && (process.platform !== 'linux' || hayEjecutable('udevadm'));

        if (listadoSeguro) {
            try {
                for (const p of await SerialPort.list()) {
                    if (vistos.has(p.path)) continue;
                    const info = [p.manufacturer, p.serialNumber].filter(Boolean).join(' · ');
                    vistos.set(p.path, { path: p.path, info });
                }
            } catch (e) { /* seguimos con lo que haya */ }
        } else if (process.platform === 'linux') {
            try {
                fs.readdirSync('/dev')
                    .filter(n => /^tty(USB|ACM|AMA|XRUSB|WCH|MFD|O)\d+$/.test(n))
                    .sort()
                    .forEach(n => { const r = '/dev/' + n; if (!vistos.has(r)) vistos.set(r, { path: r, info: '' }); });
            } catch (e) { /* sin acceso a /dev */ }
        }

        return { disponible: !!SerialPort, puertos: Array.from(vistos.values()) };
    }

    if (RED.httpAdmin) {
        RED.httpAdmin.get('/rot-client/puertos',
            RED.auth.needsPermission('rot-client.read'),
            async function (req, res) {
                try { res.json(await listarPuertos()); }
                catch (e) { res.json({ disponible: false, puertos: [], error: e.message }); }
            });
    }

    // ════════════════════════════════════════════════════════════════════════
    // Nodo de configuración: rot-client
    // ════════════════════════════════════════════════════════════════════════
    function RotClientNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Modo. Por defecto 'rtu' (RTU over TCP) para no romper las
        // configuraciones ya existentes, que no tienen este campo guardado.
        node.protocol = (config.protocol === 'tcp' || config.protocol === 'serial')
                      ? config.protocol : 'rtu';

        node.host    = config.host;
        node.port    = parseInt(config.port) || 502;
        node.timeout = (parseFloat(config.timeout) || 5) * 1000;  // seg → ms

        node.serial = {
            path:     config.serialPort || '',
            baudRate: parseInt(config.baudRate) || 9600,
            dataBits: parseInt(config.dataBits) || 8,
            parity:   ['none', 'even', 'odd', 'mark', 'space'].includes(config.parity) ? config.parity : 'none',
            stopBits: parseInt(config.stopBits) === 2 ? 2 : 1,
            echo:     config.echo === true || config.echo === 'true'
        };

        // Silencio entre tramas, en ms. Configurable desde el panel; si el campo
        // no existe (config antigua) se usan los valores por defecto. En Modbus
        // TCP nativo no hay bus serie que drenar, asi que el defecto ahi es 0.
        const gapDef    = node.protocol === 'tcp' ? 0   : 50;
        const gapErrDef = node.protocol === 'tcp' ? 200 : 500;
        node.gap    = config.gap      !== undefined && config.gap      !== ''
                    ? parseInt(config.gap)      : gapDef;
        node.gapErr = config.gapError !== undefined && config.gapError !== ''
                    ? parseInt(config.gapError) : gapErrDef;

        // Una sola cola por nodo de configuración
        node._queue = new ModbusQueue({
            protocol: node.protocol,
            host:     node.host,
            port:     node.port,
            serial:   node.serial,
            timeout:  node.timeout,
            gapMs:    node.gap,
            gapErrMs: node.gapErr,
            // Propagar estado a todos los nodos suscriptores
            onStatus: (fill, shape, text) => node.emit('status', { fill, shape, text })
        });

        // ── Métodos públicos que usan rot-read y rot-write ────────────────────

        node.read = function (deviceId, fc, startReg, count) {
            // Tamano exacto de la respuesta RTU esperada, calculado desde LA
            // PETICION (no desde el fragmento recibido). Para FC01/FC02 (coils)
            // el area de datos es ceil(count/8) bytes; para FC03/FC04
            // (registros) es count*2.
            // Trama = slave(1) + fc(1) + byteCount(1) + datos + CRC(2).
            // En Modbus TCP este dato no se usa: la longitud la da el MBAP.
            const expectedLen = 3 + bytesDeDatos(fc, count) + 2;
            return node._queue.enqueue({
                pdu:         pduRead(fc, startReg, count),
                deviceId:    deviceId,
                fc:          fc,
                type:        'read',
                minBytes:    5,
                expectedLen: expectedLen,
                parseRtu:    buf => parseReadResponse(buf, fc, count),
                parsePdu:    pdu => parsePduRead(pdu, fc, count)
            });
        };

        function encolarEscritura(pdu, deviceId, fc) {
            return node._queue.enqueue({
                pdu:         pdu,
                deviceId:    deviceId,
                fc:          fc,
                type:        'write',
                minBytes:    8,
                expectedLen: 8,
                parseRtu:    buf => parseWriteResponse(buf, fc),
                parsePdu:    p   => parsePduWrite(p, fc)
            });
        }

        node.writeFC05 = function (deviceId, reg, value) {
            return encolarEscritura(pduFC05(reg, value), deviceId, 0x05);
        };

        node.writeFC06 = function (deviceId, reg, value) {
            return encolarEscritura(pduFC06(reg, value), deviceId, 0x06);
        };

        node.writeFC15 = function (deviceId, reg, values) {
            return encolarEscritura(pduFC15(reg, values), deviceId, 0x0F);
        };

        node.writeFC16 = function (deviceId, reg, values) {
            return encolarEscritura(pduFC16(reg, values), deviceId, 0x10);
        };

        node.subscribe   = () => node._queue.subscribe();
        node.unsubscribe = () => node._queue.unsubscribe();

        // Node-RED espera a 'done' antes de arrancar los flujos nuevos. En
        // serie es imprescindible: el cliente del siguiente deploy abre la
        // MISMA ruta y fallaria con "puerto ocupado" si el viejo no ha
        // terminado de cerrarla.
        node.on('close', function (removed, done) {
            node._queue.destroy().then(() => done(), () => done());
        });
    }

    RED.nodes.registerType('rot-client', RotClientNode);
};
