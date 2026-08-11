module.exports = function (RED) {

    // ── Endpoint HTTP para el botón del nodo (modo sin Inject) ────────────────
    RED.httpAdmin.post(
        '/rot-read/:id',
        RED.auth.needsPermission('rot-read.write'),
        function (req, res) {
            const node = RED.nodes.getNode(req.params.id);
            if (node) {
                try { node.receive({}); res.sendStatus(200); }
                catch (err) { res.sendStatus(500); }
            } else {
                res.sendStatus(404);
            }
        }
    );

    // ════════════════════════════════════════════════════════════════════════
    // Nodo ROT Read
    // ════════════════════════════════════════════════════════════════════════
    function RotReadNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Cliente POR DEFECTO (el del panel). Puede ser vacío si el flujo va a
        // resolver siempre el cliente por msg.clientId.
        const defaultClient = RED.nodes.getNode(config.client) || null;

        // Parámetros propios del nodo (el timeout viene del cliente)
        const deviceId     = parseInt(config.deviceId)       || 1;
        const fc           = parseInt(config.fc)             || 4;
        const startReg     = parseInt(config.startReg)       || 0;
        const count        = parseInt(config.count)          || 10;
        const pollSec      = parseFloat(config.pollInterval) || 0;
        const pollInterval = pollSec > 0 ? pollSec * 1000 : 0;

        // ── Gestión de suscripciones a clientes ───────────────────────────────
        // Con multi-cliente un mismo rot-read puede hablar con varios rot-client.
        // Nos suscribimos a cada uno la primera vez que lo usamos (para mantener
        // su socket vivo y recibir su estado) y liberamos todos al cerrar.
        const subscritos = new Map();   // clientId -> { clientNode, onStatus }

        function usarCliente(clientNode) {
            if (!clientNode || subscritos.has(clientNode.id)) return;
            clientNode.subscribe();
            // El estado de fondo (conectado, reconectando, caido) solo se pinta
            // cuando este rot-read usa UN unico cliente. Con dos o mas, cada
            // cliente emitiria su propio estado y el ultimo pisaria al resto,
            // mostrando algo que no corresponde a la operacion en curso; en ese
            // caso callamos el estado de fondo y deja que lo gobierne executeRead
            // (que siempre sabe con que cliente esta trabajando ahora mismo).
            const onStatus = (s) => { if (subscritos.size <= 1) node.status(s); };
            clientNode.on('status', onStatus);
            subscritos.set(clientNode.id, { clientNode, onStatus });
        }

        // Resuelve el cliente a usar para ESTE mensaje:
        //   1) msg.clientId  -> cliente elegido por el termostato (multi-gateway)
        //   2) config.client -> cliente del panel (comportamiento clásico)
        function resolverCliente(msg) {
            if (msg && msg.clientId) {
                const c = RED.nodes.getNode(msg.clientId);
                if (!c) throw new Error('Cliente no encontrado: ' + msg.clientId);
                return c;
            }
            if (defaultClient) return defaultClient;
            throw new Error('Sin cliente: define uno en el panel o envia msg.clientId');
        }

        // Suscripcion inicial al cliente del panel (si lo hay), para que su
        // socket arranque y el estado se refleje como hasta ahora.
        if (defaultClient) usarCliente(defaultClient);

        node.status({ fill: 'grey', shape: 'ring', text: 'inactivo' });

        let pollingTimer = null;

        // ── Ejecutar una lectura ──────────────────────────────────────────────
        const executeRead = async (msg) => {
            let client;
            try {
                client = resolverCliente(msg);
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: err.message });
                node.error(err.message, msg);
                const errMsg   = RED.util.cloneMessage(msg);
                errMsg.payload = null;
                errMsg.error   = err.message;
                node.send([null, null, errMsg]);
                return;
            }
            usarCliente(client);   // asegura suscripcion la primera vez

            const p = {
                deviceId: msg.deviceId || deviceId,
                fc:       msg.fc       ? parseInt(msg.fc) : fc,
                startReg: msg.startReg !== undefined ? parseInt(msg.startReg) : startReg,
                count:    msg.count    ? parseInt(msg.count) : count
            };

            node.status({ fill: 'yellow', shape: 'dot', text: 'leyendo…' });

            try {
                const data = await client.read(p.deviceId, p.fc, p.startReg, p.count);
                const ts   = new Date().toISOString();
                node.status({ fill: 'blue', shape: 'dot', text: 'ok · ' + new Date().toLocaleTimeString() });

                const msgDec     = RED.util.cloneMessage(msg);
                msgDec.payload   = data.decimal;
                msgDec.timestamp = ts;
                msgDec.topic     = 'modbus/decimal';

                const msgHex     = RED.util.cloneMessage(msg);
                msgHex.payload   = data.hex;
                msgHex.timestamp = ts;
                msgHex.topic     = 'modbus/hex';

                node.send([msgDec, msgHex, null]);

            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: err.message });
                node.error(err.message, msg);
                const errMsg   = RED.util.cloneMessage(msg);
                errMsg.payload = null;
                errMsg.error   = err.message;
                node.send([null, null, errMsg]);
            }
        };

        // ── Polling automatico ────────────────────────────────────────────────
        // (usa el cliente del panel, ya que no hay msg que traiga clientId)
        if (pollInterval > 0) {
            node.status({ fill: 'blue', shape: 'ring', text: 'polling cada ' + pollSec + 's' });
            pollingTimer = setInterval(() => executeRead({}), pollInterval);
        }

        // ── Input (Inject externo o boton) ────────────────────────────────────
        node.on('input', function (msg) {
            if (msg.stop) {
                if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
                node.status({ fill: 'grey', shape: 'ring', text: 'polling detenido' });
                return;
            }
            executeRead(msg);
        });

        // ── Cierre ────────────────────────────────────────────────────────────
        node.on('close', () => {
            if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
            // Liberar TODOS los clientes a los que nos suscribimos
            for (const { clientNode, onStatus } of subscritos.values()) {
                clientNode.removeListener('status', onStatus);
                clientNode.unsubscribe();
            }
            subscritos.clear();
            node.status({});
        });
    }

    RED.nodes.registerType('rot-read', RotReadNode);
};
