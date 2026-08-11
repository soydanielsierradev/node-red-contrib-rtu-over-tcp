module.exports = function (RED) {

    // ── Validar y normalizar payload según función ────────────────────────────
    function resolvePayload(fc, payload, configValue, configValues) {
        if (fc === 0x05) {
            const val = (payload !== undefined && payload !== null) ? payload : configValue;
            if (val === undefined || val === null) throw new Error('FC05: falta el valor del coil en msg.payload');
            return val;
        }
        if (fc === 0x06) {
            const val = (payload !== undefined && payload !== null) ? payload : configValue;
            if (val === undefined || val === null) throw new Error('FC06: falta el valor en msg.payload');
            if (typeof val !== 'number') throw new Error('FC06: msg.payload debe ser un numero');
            return val;
        }
        if (fc === 0x0F) {
            const vals = Array.isArray(payload) ? payload : Array.isArray(configValues) ? configValues : null;
            if (!vals || vals.length === 0) throw new Error('FC15: msg.payload debe ser un array de booleanos');
            return vals;
        }
        if (fc === 0x10) {
            const vals = Array.isArray(payload) ? payload : Array.isArray(configValues) ? configValues : null;
            if (!vals || vals.length === 0) throw new Error('FC16: msg.payload debe ser un array de numeros');
            return vals;
        }
        throw new Error('Funcion no soportada: FC' + fc + '. Usa FC05, FC06, FC15 o FC16.');
    }

    // ════════════════════════════════════════════════════════════════════════
    // Nodo ROT Write
    // ════════════════════════════════════════════════════════════════════════
    function RotWriteNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Cliente POR DEFECTO (el del panel). Puede quedar vacio si el flujo
        // resuelve siempre el cliente por msg.clientId.
        const defaultClient = RED.nodes.getNode(config.client) || null;

        // Parámetros propios del nodo
        const deviceId     = parseInt(config.deviceId) || 1;
        const fc           = parseInt(config.fc)       || 6;
        const startReg     = parseInt(config.startReg) || 0;
        const configValue  = config.value !== '' ? parseFloat(config.value) : undefined;
        const configValues = (() => {
            try { return JSON.parse(config.values || '[]'); } catch { return []; }
        })();

        // ── Gestión de suscripciones a clientes (multi-gateway) ───────────────
        const subscritos = new Map();   // clientId -> { clientNode, onStatus }

        function usarCliente(clientNode) {
            if (!clientNode || subscritos.has(clientNode.id)) return;
            clientNode.subscribe();
            // Estado de fondo solo con un unico cliente (ver nota en rot-read).
            const onStatus = (s) => { if (subscritos.size <= 1) node.status(s); };
            clientNode.on('status', onStatus);
            subscritos.set(clientNode.id, { clientNode, onStatus });
        }

        function resolverCliente(msg) {
            if (msg && msg.clientId) {
                const c = RED.nodes.getNode(msg.clientId);
                if (!c) throw new Error('Cliente no encontrado: ' + msg.clientId);
                return c;
            }
            if (defaultClient) return defaultClient;
            throw new Error('Sin cliente: define uno en el panel o envia msg.clientId');
        }

        if (defaultClient) usarCliente(defaultClient);

        node.status({ fill: 'grey', shape: 'ring', text: 'inactivo' });

        // ── Procesar mensaje entrante ─────────────────────────────────────────
        node.on('input', async function (msg) {
            let client;
            try {
                client = resolverCliente(msg);
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: err.message });
                node.error(err.message, msg);
                const errMsg   = RED.util.cloneMessage(msg);
                errMsg.payload = null;
                errMsg.error   = err.message;
                node.send([null, errMsg]);
                return;
            }
            usarCliente(client);

            const p = {
                deviceId: msg.deviceId || deviceId,
                fc:       msg.fc       ? parseInt(msg.fc) : fc,
                startReg: msg.startReg !== undefined ? parseInt(msg.startReg) : startReg,
            };

            // Resolver payload y ejecutar escritura
            let result;
            try {
                node.status({ fill: 'yellow', shape: 'dot', text: 'escribiendo…' });
                const payload = msg.payload;

                if (p.fc === 5) {
                    const val = resolvePayload(0x05, payload, configValue, configValues);
                    result = await client.writeFC05(p.deviceId, p.startReg, val);
                } else if (p.fc === 6) {
                    const val = resolvePayload(0x06, payload, configValue, configValues);
                    result = await client.writeFC06(p.deviceId, p.startReg, val);
                } else if (p.fc === 15) {
                    const vals = resolvePayload(0x0F, payload, configValue, configValues);
                    result = await client.writeFC15(p.deviceId, p.startReg, vals);
                } else if (p.fc === 16) {
                    const vals = resolvePayload(0x10, payload, configValue, configValues);
                    result = await client.writeFC16(p.deviceId, p.startReg, vals);
                } else {
                    throw new Error('Funcion no soportada: FC' + p.fc);
                }

                const ts      = new Date().toISOString();
                node.status({ fill: 'blue', shape: 'dot', text: 'ok · ' + new Date().toLocaleTimeString() });
                const msgOk   = RED.util.cloneMessage(msg);
                msgOk.payload = result;
                msgOk.timestamp = ts;
                msgOk.topic   = 'modbus/write';
                node.send([msgOk, null]);

            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: err.message });
                node.error(err.message, msg);
                const errMsg   = RED.util.cloneMessage(msg);
                errMsg.payload = null;
                errMsg.error   = err.message;
                node.send([null, errMsg]);
            }
        });

        // ── Cierre ────────────────────────────────────────────────────────────
        node.on('close', () => {
            for (const { clientNode, onStatus } of subscritos.values()) {
                clientNode.removeListener('status', onStatus);
                clientNode.unsubscribe();
            }
            subscritos.clear();
            node.status({});
        });
    }

    RED.nodes.registerType('rot-write', RotWriteNode);
};
