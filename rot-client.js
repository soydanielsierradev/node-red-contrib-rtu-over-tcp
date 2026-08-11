module.exports = function (RED) {

    // ════════════════════════════════════════════════════════════════════════
    // Utilidades RTU compartidas
    // ════════════════════════════════════════════════════════════════════════

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

    function appendCRC(frame, dataLen) {
        const c = crc16(frame.slice(0, dataLen));
        frame[dataLen]     = c & 0xFF;
        frame[dataLen + 1] = (c >> 8) & 0xFF;
        return frame;
    }

    // ── Builders de frame ─────────────────────────────────────────────────────

    // FC03 / FC04 — Read Registers
    function buildReadFrame(deviceId, fc, startReg, count) {
        const f = Buffer.alloc(8);
        f[0] = deviceId; f[1] = fc;
        f[2] = (startReg >> 8) & 0xFF; f[3] = startReg & 0xFF;
        f[4] = (count >> 8) & 0xFF;    f[5] = count & 0xFF;
        return appendCRC(f, 6);
    }

    // FC05 — Write Single Coil
    function buildFC05(deviceId, reg, value) {
        const v = (value === true || value === 1 || value === 0xFF00) ? 0xFF00 : 0x0000;
        const f = Buffer.alloc(8);
        f[0] = deviceId; f[1] = 0x05;
        f[2] = (reg >> 8) & 0xFF; f[3] = reg & 0xFF;
        f[4] = (v >> 8) & 0xFF;   f[5] = v & 0xFF;
        return appendCRC(f, 6);
    }

    // FC06 — Write Single Register
    function buildFC06(deviceId, reg, value) {
        const v = value & 0xFFFF;
        const f = Buffer.alloc(8);
        f[0] = deviceId; f[1] = 0x06;
        f[2] = (reg >> 8) & 0xFF; f[3] = reg & 0xFF;
        f[4] = (v >> 8) & 0xFF;   f[5] = v & 0xFF;
        return appendCRC(f, 6);
    }

    // FC15 — Write Multiple Coils
    function buildFC15(deviceId, reg, values) {
        const count     = values.length;
        const byteCount = Math.ceil(count / 8);
        const f         = Buffer.alloc(7 + byteCount + 2);
        f[0] = deviceId; f[1] = 0x0F;
        f[2] = (reg >> 8) & 0xFF; f[3] = reg & 0xFF;
        f[4] = (count >> 8) & 0xFF; f[5] = count & 0xFF;
        f[6] = byteCount;
        for (let i = 0; i < count; i++)
            if (values[i]) f[7 + Math.floor(i / 8)] |= (1 << (i % 8));
        return appendCRC(f, 7 + byteCount);
    }

    // FC16 — Write Multiple Registers
    function buildFC16(deviceId, reg, values) {
        const count     = values.length;
        const byteCount = count * 2;
        const f         = Buffer.alloc(7 + byteCount + 2);
        f[0] = deviceId; f[1] = 0x10;
        f[2] = (reg >> 8) & 0xFF; f[3] = reg & 0xFF;
        f[4] = (count >> 8) & 0xFF; f[5] = count & 0xFF;
        f[6] = byteCount;
        for (let i = 0; i < count; i++) {
            const v = values[i] & 0xFFFF;
            f[7 + i * 2] = (v >> 8) & 0xFF;
            f[8 + i * 2] = v & 0xFF;
        }
        return appendCRC(f, 7 + byteCount);
    }

    // ── Parsers de respuesta ──────────────────────────────────────────────────

    // FC01/FC02 — Read Coils / Read Discrete Inputs
    // Respuesta: [devId][FC][byteCount][bits empaquetados...][CRC_L][CRC_H]
    // Cada byte contiene 8 coils: bit0 = coil[0], bit1 = coil[1], etc.
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
        const decimal = [], hex = [];
        for (let i = 0; i < count; i++) {
            const bit = (buf[3 + Math.floor(i / 8)] >> (i % 8)) & 1;
            decimal[i] = bit;
            hex[i]     = bit ? '0x0001' : '0x0000';
        }
        return { decimal, hex, expectedBytes: expected };
    }

    // FC03/FC04 — Read Holding/Input Registers
    // Respuesta: [devId][FC][byteCount][val0H][val0L]...[CRC_L][CRC_H]
    // Cada par de bytes = un registro de 16 bits con signo
    function parseRegisterResponse(buf, count) {
        const expected = 3 + count * 2 + 2;
        if (buf.length >= 3 && (buf[1] & 0x80))
            throw new Error(descExcepcion(buf[1] & 0x7F, buf[2]));
        if (buf.length < expected)
            throw new Error('Respuesta corta: ' + buf.length + ' bytes, esperados ' + expected);
        const rxCRC = buf[expected - 2] | (buf[expected - 1] << 8);
        if (rxCRC !== crc16(buf.slice(0, expected - 2)))
            throw new Error('CRC inválido en respuesta de lectura de registros');
        const decimal = [], hex = [];
        for (let i = 0; i < count; i++) {
            const raw    = (buf[3 + i * 2] << 8) | buf[4 + i * 2];
            const signed = raw < 32768 ? raw : raw - 65536;
            decimal[i]   = signed;
            hex[i]       = '0x' + raw.toString(16).toUpperCase().padStart(4, '0');
        }
        return { decimal, hex, expectedBytes: expected };
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

    // ════════════════════════════════════════════════════════════════════════
    // TcpQueue — cola serializada sobre un socket persistente
    // Un único socket compartido entre todos los nodos que usen este cliente.
    // Las peticiones se encolan y se envían de una en una para evitar
    // colisiones en el bus RS485.
    // ════════════════════════════════════════════════════════════════════════
    class TcpQueue {
        constructor(host, port, timeout, onStatus, gapMs, gapErrMs) {
            this.host     = host;
            this.port     = port;
            this.timeout  = timeout;   // ms
            this.onStatus = onStatus;  // (fill, shape, text) => {}

            // Silencio entre tramas. 50 ms cubre el t3.5 de sobra a 9600 baudios
            // y sigue permitiendo un sondeo rapido; subelo si el bus es largo,
            // tiene muchos slaves o el gateway es lento.
            this.gapMs    = gapMs    !== undefined ? gapMs    : 50;
            this.gapErrMs = gapErrMs !== undefined ? gapErrMs : 500;

            this._socket         = null;
            this._rxBuf          = Buffer.alloc(0);
            this._queue          = [];
            this._active         = null;
            this._closed         = false;
            this._connecting     = false;
            this._reconnectTimer = null;
            this._gapTimer       = null;
            this._lastFallo      = false;
            this._subscribers    = 0;   // nodos conectados a este cliente
        }

        // ── Conexión ──────────────────────────────────────────────────────────
        _connect() {
            if (this._socket && !this._socket.destroyed) return;
            if (this._connecting) return;
            this._connecting = true;

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
                this.onStatus('green', 'dot', 'conectado · ' + this.host + ':' + this.port);
                this._flush();
            });

            socket.on('data', chunk => {
                this._rxBuf = Buffer.concat([this._rxBuf, chunk]);
                this._tryParse();
            });

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

        _handleDisconnect(err) {
            if (this._socket) {
                this._socket.removeAllListeners();
                if (!this._socket.destroyed) this._socket.destroy();
                this._socket = null;
            }
            this._connecting = false;
            this._rxBuf      = Buffer.alloc(0);

            if (this._active) {
                clearTimeout(this._active.timer);
                this._active.reject(err);
                this._active = null;
            }

            if (this._closed) return;
            this.onStatus('red', 'ring', err.message);

            // Reconexion automatica. Antes solo se reintentaba si quedaban
            // peticiones en cola: si el socket caia estando el bus en reposo,
            // nadie reconectaba y la primera lectura posterior se comia un
            // timeout entero antes de que _connect() lo arreglara de rebote.
            if ((this._queue.length > 0 || this._subscribers > 0) && !this._reconnectTimer) {
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
            if (!this._socket || this._socket.destroyed) { this._connect(); return; }
            if (this._connecting) return;   // el callback de connect hara el flush

            const req    = this._queue.shift();
            this._active = req;
            this._rxBuf  = Buffer.alloc(0);

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
                this._socket.write(req.frame);
            } catch (e) {
                clearTimeout(req.timer);
                this._active = null;
                req.reject(new Error('Error al enviar frame: ' + e.message));
                this._flush();
            }
        }

        _tryParse() {
            if (!this._active) return;
            const req = this._active;

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
                const result = req.parse(this._rxBuf);
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
            this._gapTimer = setTimeout(() => {
                this._gapTimer = null;
                this._flush();
            }, ms);
        }

        // ── API pública ───────────────────────────────────────────────────────

        enqueue(frame, minBytes, type, parseFn, expectedLen, deviceId, fc) {
            return new Promise((resolve, reject) => {
                this._queue.push({ frame, minBytes, type, parse: parseFn, expectedLen: expectedLen || 0, deviceId: deviceId, fc: fc, resolve, reject, timer: null });
                this._connect();
                if (this._socket && !this._socket.destroyed && !this._connecting)
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

        destroy() {
            this._closed = true;
            if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
            if (this._gapTimer) { clearTimeout(this._gapTimer); this._gapTimer = null; }
            if (this._active) { clearTimeout(this._active.timer); this._active.reject(new Error('Cliente cerrado')); this._active = null; }
            this._queue.forEach(r => r.reject(new Error('Cliente cerrado')));
            this._queue = [];
            if (this._socket) {
                this._socket.removeAllListeners();
                if (!this._socket.destroyed) this._socket.destroy();
                this._socket = null;
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Nodo de configuración: rot-client
    // ════════════════════════════════════════════════════════════════════════
    function RotClientNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.host    = config.host;
        node.port    = parseInt(config.port)    || 502;
        node.timeout = (parseFloat(config.timeout) || 5) * 1000;  // seg → ms

        // Silencio entre tramas, en ms. Configurable desde el panel; si el campo
        // no existe (config antigua) se usan los valores por defecto.
        node.gap    = config.gap      !== undefined && config.gap      !== ''
                    ? parseInt(config.gap)      : 50;
        node.gapErr = config.gapError !== undefined && config.gapError !== ''
                    ? parseInt(config.gapError) : 500;

        // Una sola instancia de TcpQueue por nodo de configuración
        node._queue = new TcpQueue(
            node.host,
            node.port,
            node.timeout,
            (fill, shape, text) => {
                // Propagar estado a todos los nodos suscriptores
                node.emit('status', { fill, shape, text });
            },
            node.gap,
            node.gapErr
        );

        // ── Métodos públicos que usan rot-read y rot-write ────────────────────

        node.read = function (deviceId, fc, startReg, count) {
            const frame    = buildReadFrame(deviceId, fc, startReg, count);
            // FC01/FC02: mínimo 3 + ceil(count/8) + 2 bytes
            // FC03/FC04: mínimo 3 + count*2 + 2 bytes
            // Usamos 5 como mínimo absoluto (devId+FC+byteCount+2CRC) y dejamos
            // que _tryParse calcule el tamaño real desde buf[2] (byteCount)
            // Tamano exacto de la respuesta esperada, calculado desde LA PETICION
            // (no desde el fragmento recibido). Para FC01/FC02 (coils) el area de
            // datos es ceil(count/8) bytes; para FC03/FC04 (registros) es count*2.
            // Trama = slave(1) + fc(1) + byteCount(1) + datos + CRC(2).
            const dataBytes = (fc === 1 || fc === 2) ? Math.ceil(count / 8) : count * 2;
            const expectedLen = 3 + dataBytes + 2;
            return node._queue.enqueue(
                frame,
                5,
                'read',
                buf => parseReadResponse(buf, fc, count),
                expectedLen,
                deviceId,
                fc
            );
        };

        node.writeFC05 = function (deviceId, reg, value) {
            const frame = buildFC05(deviceId, reg, value);
            return node._queue.enqueue(frame, 8, 'write', buf => parseWriteResponse(buf, 0x05), 8, deviceId, 0x05);
        };

        node.writeFC06 = function (deviceId, reg, value) {
            const frame = buildFC06(deviceId, reg, value);
            return node._queue.enqueue(frame, 8, 'write', buf => parseWriteResponse(buf, 0x06), 8, deviceId, 0x06);
        };

        node.writeFC15 = function (deviceId, reg, values) {
            const frame = buildFC15(deviceId, reg, values);
            return node._queue.enqueue(frame, 8, 'write', buf => parseWriteResponse(buf, 0x0F), 8, deviceId, 0x0F);
        };

        node.writeFC16 = function (deviceId, reg, values) {
            const frame = buildFC16(deviceId, reg, values);
            return node._queue.enqueue(frame, 8, 'write', buf => parseWriteResponse(buf, 0x10), 8, deviceId, 0x10);
        };

        node.subscribe   = () => node._queue.subscribe();
        node.unsubscribe = () => node._queue.unsubscribe();

        node.on('close', () => node._queue.destroy());
    }

    RED.nodes.registerType('rot-client', RotClientNode);
};
