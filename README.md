<img src="./icons/rot.png" width="32" height="32">
<img src="https://cdn.worldvectorlogo.com/logos/node-red-1.svg" width="32" height="32"> node-red-contrib-rtu-over-tcp

**Autor:** Daniel Sierra

**Descripción:** Nodos Node-RED para leer y escribir registros Modbus en **RTU over TCP**, **Modbus TCP** y **Modbus RTU por puerto serie**

---

Tres modos con la misma interfaz de nodos, seleccionables desde el cliente:

| Modo | Medio | Trama enviada | Para qué equipos |
|------|-------|---------------|------------------|
| **RTU over TCP** | Socket TCP | `[slaveId] + PDU + CRC16` | Conversores serie↔ethernet transparentes (Teltonika TRB, USR, Elfin, HF2211…) |
| **Modbus TCP** | Socket TCP | `MBAP(7 bytes) + PDU`, sin CRC | PLCs, analizadores de red, variadores, I/O remotas y pasarelas que traducen a MBAP |
| **RTU serie** | Puerto serie local | `[slaveId] + PDU + CRC16` | Adaptador USB-RS485, UART / HAT RS485 de Raspberry Pi, puertos COM |

Enlace **persistente con reconexión automática** y cola de peticiones serializada.

Compatible con: Ibercon RS485.

---

## Instalación del paquete

Este paquete se distribuye como un archivo `.tgz`. A continuación, se detallan las formas de descarga e instalación.

### 1. Descargar el paquete

1. Ir a la pestaña **Releases** del repositorio
2. Abrir la release más reciente (marcada como *Latest*)
3. Descargar el archivo `.tgz` adjunto

### 2. Instalación en Node-RED

1. Abrir Node-RED
2. Ir a: Menu → Manage Palette → Install
3. Seleccionar Upload
4. Seleccionar el archivo `.tgz`
5. Confirmar instalación

---

## Nodos disponibles

| Nodo | Descripción |
|------|-------------|
| **rot-client** | Nodo de configuración. Gestiona la conexión TCP y la cola de peticiones. |
| **rot-read** | Lee coils y registros Modbus (FC01, FC02, FC03, FC04). |
| **rot-write** | Escribe registros Modbus (FC05, FC06, FC15, FC16). |

---

## Configuración

### ROT Client (nodo de configuración)

| Campo           | Descripción                                         | Ejemplo       |
|-----------------|----------------------------------------------------|---------------|
| Nombre          | Etiqueta opcional para el nodo                     | Mi gateway   |
| IP / Host       | Dirección IP o hostname del conversor TCP        | 192.168.1.100 |
| Puerto          | Puerto TCP del conversor                          | 502           |
| Timeout         | Tiempo máximo de espera por respuesta, en seg.   | 5             |

> **Nota:** Todos los nodos `rot-read` y `rot-write` deben seleccionar un `ROT Client` existente.

### ROT Read

| Campo           | Descripción                                                          | Ejemplo       |
|-----------------|----------------------------------------------------------------------|---------------|
| Nombre          | Etiqueta opcional para el nodo                                       | Mi sensor     |
| ROT Client      | Nodo de configuración compartido                                   | (selección)   |
| Usar con Inject | Marcado: pin de entrada visible. Desmarcado: botón integrado en nodo | ✓             |
| Slave ID        | Device ID en el bus RS485                                            | 5             |
| Función         | FC01 Read Coil / FC02 Read Discrete Input / FC03 Holding / FC04 Input | FC04          |
| Reg. inicial    | Dirección del primer registro (base 0)                               | 0             |
| Cantidad        | Número de registros a leer                                           | 45            |
| Intervalo       | Segundos entre lecturas automáticas. `0` = solo por disparador     | 1             |

### ROT Write

| Campo           | Descripción                                                          | Ejemplo       |
|-----------------|----------------------------------------------------------------------|---------------|
| Nombre          | Etiqueta opcional para el nodo                                       | Escritor      |
| ROT Client      | Nodo de configuración compartido                                   | (selección)   |
| Función         | FC05 Write Single Coil / FC06 Write Single Register / FC15 Write Multiple Coils / FC16 Write Multiple Registers | FC16 |
| Slave ID        | Device ID en el bus RS485                                            | 5             |
| Reg. inicial    | Dirección del primer registro (base 0)                               | 0             |
| Valor           | Valor fijo para FC05/FC06 (opcional, se puede enviar por msg.payload) | 1234          |
| Valores         | Array JSON de valores para FC15/FC16 (opcional)                       | `[1,0,1,1]`  |

---

## Modos de disparo (rot-read)

| Modo | Descripción |
|------|-------------|
| **Inject externo** | `Usar con Inject` marcado. El nodo expone un pin de entrada. Conecta un nodo Inject, Change u otro disparador. |
| **Botón integrado** | `Usar con Inject` desmarcado. El nodo tiene un botón propio (igual al nodo Inject nativo). No necesita pin de entrada. |
| **Polling automático** | `Intervalo > 0`. El nodo lanza lecturas periódicas independientemente del modo de disparador. |
| **Detener polling** | Envía `msg.stop = true` a la entrada del nodo en cualquier momento. |

---

## Salidas

### rot-read

| Salida | `msg.topic`      | `msg.payload` | Notas |
|--------|------------------|---------------|-------|
| 1      | `modbus/decimal` | FC01/FC02: array de `0`/`1`. FC03/FC04: array de int16 con signo | Incluye `msg.timestamp` ISO 8601 |
| 2      | `modbus/hex`     | Array de strings `"0xXXXX"` (en coils, `"0x0000"`/`"0x0001"`) | Incluye `msg.timestamp` ISO 8601 |
| 3      | —                | `null` | `msg.error` = descripción del fallo |

### rot-write

| Salida | `msg.topic`    | `msg.payload` | Notas |
|--------|----------------|---------------|-------|
| 1      | `modbus/write` | FC05/FC06: `{ reg, value }`. FC15/FC16: `{ reg, count }` | Incluye `msg.timestamp` ISO 8601 |
| 2      | —              | `null` | `msg.error` = descripción del fallo |

---

## Sobreescribir parámetros por mensaje

Estos campos del mensaje de entrada sustituyen, solo para esa operación, a los del panel.
Son los únicos que leen los nodos:

### Para rot-read

```javascript
msg.clientId = "a1b2c3d4.e5f6";  // id de otro rot-client (ver abajo)
msg.deviceId = 3;                // Slave ID (RTU) / Unit ID (TCP)
msg.fc       = 3;                // 1 = FC01, 2 = FC02, 3 = FC03, 4 = FC04
msg.startReg = 100;              // registro inicial
msg.count    = 20;               // cantidad de registros
msg.stop     = true;             // detiene el polling automático (no lee)
```

### Para rot-write

```javascript
msg.clientId = "a1b2c3d4.e5f6";  // id de otro rot-client (ver abajo)
msg.deviceId = 3;                // Slave ID (RTU) / Unit ID (TCP)
msg.fc       = 16;               // 5 = FC05, 6 = FC06, 15 = FC15, 16 = FC16
msg.startReg = 100;              // registro inicial
msg.payload  = [1, 2, 3, 4];     // valores a escribir (FC15/FC16)
msg.payload  = 1234;             // valor único (FC05/FC06)
```

### Cambiar de equipo o de medio por mensaje: `msg.clientId`

La conexión (IP, puerto, puerto serie, protocolo, timeout, silencio entre tramas) **no se
sobreescribe por mensaje**: pertenece al `rot-client`. Para hablar con varios equipos desde
un mismo nodo, crea un `rot-client` por equipo (o por bus) y envía en `msg.clientId` el id del
que toque. El id se ve en el panel de información de Node-RED al seleccionar el nodo de
configuración. Así cada destino conserva su enlace persistente y su cola, en vez de abrir
conexiones temporales.

El polling automático de `rot-read` usa siempre el cliente del panel.

---

## Funciones Modbus soportadas

| Código | Función | Descripción              | Payload de entrada        | Salida               |
|--------|---------|-------------------------|-------------------------|----------------------|
| FC01   | Read Coil Inputs       | Lee coils (bits)         | —                     | array de 0/1           |
| FC02   | Read Discrete Inputs  | Lee entradas discretas | —                     | array de 0/1         |
| FC03   | Read Holding Registers| Lee registros (int16) | —                     | array de int16       |
| FC04   | Read Input Registers  | Lee registros de entrada | —                     | array de int16       |
| FC05   | Write Single Coil      | `true/false` o `0/1`     | `msg.payload`             | —                 |
| FC06   | Write Single Register  | número (int16)          | `msg.payload`             | —                 |
| FC15   | Write Multiple Coils   | array de booleanos      | `msg.payload = [...]`     | —                 |
| FC16   | Write Multiple Registers| array de números      | `msg.payload = [...]`    | —                 |

---

## Comportamiento de la conexión TCP

El nodo `rot-client` mantiene una **conexión TCP persistente** con el conversor:

- Se conecta al primer disparo o al arrancar si el polling está activo.
- Las peticiones se encolan y se ejecutan en serie (una a una), evitando colisiones en el bus RS485.
- Ante desconexión inesperada, la petición en curso recibe error y el nodo reintenta la conexión automáticamente en **2 segundos** si hay peticiones pendientes.
- Al cerrar el nodo (deploy / reinicio) la conexión se cierra limpiamente.
- El indicador de estado refleja el estado en tiempo real: `inactivo` → `conectado` → `leyendo…` → `ok` / `error`.

---

## Elegir el protocolo

Se configura en el nodo **rot-client**, campo **Modo** (`rtu`, `tcp` o `serial`). Los nodos `rot-read` y `rot-write`
no cambian: mismos códigos de función, mismos registros, mismas salidas.

Las configuraciones creadas antes de la 1.1.0 no tienen este campo guardado y se
interpretan como **RTU over TCP**, así que los flujos existentes siguen funcionando igual.

**Cómo saber si el modo es el correcto:** si el equipo responde pero el nodo reporta
`CRC inválido`, prueba con Modbus TCP; si reporta `Cabecera MBAP inválida`, prueba con
RTU over TCP.

### Slave ID / Unit ID

Es el mismo campo del nodo Read/Write en ambos modos. En RTU es la dirección del esclavo
en el bus RS485; en Modbus TCP es el Unit ID del MBAP, que los equipos con ethernet nativo
suelen ignorar (normalmente `1` o `255`) y que las pasarelas usan como slave id real.

### Silencio entre tramas

En RTU es obligatorio (t3.5): el esclavo necesita soltar la línea RS485 antes de la
siguiente petición. En modo serie el cliente **nunca baja del t3.5 real** del bus
(p. ej. 33 ms a 1200 baudios) aunque se configure menos. En Modbus TCP nativo no hay bus
que drenar y el valor por defecto es **0 ms**; súbelo solo si el destino es una pasarela
hacia RS485 o si el equipo se satura.

---

## Modo RTU por puerto serie

Usa el módulo [`serialport`](https://serialport.io) (v12, el mismo que el nodo oficial
`node-red-node-serialport`). Va como **dependencia opcional**: se instala con el paquete,
pero si su compilación fallara en alguna plataforma, los modos TCP siguen funcionando y el
modo serie avisa de que falta el módulo.

**Configuración:** puerto, baudios, bits de datos, paridad y bits de parada. Deben coincidir
con los de todos los esclavos del bus (lo más habitual es 9600 8N1). El botón de lupa del
panel lista los puertos del servidor donde corre Node-RED.

**Un cliente por puerto.** Un puerto serie solo puede abrirlo un proceso a la vez. Todos los
nodos Read/Write de un mismo bus deben compartir el mismo `rot-client`. Si dos clientes
apuntan a la misma ruta, el segundo muestra *Puerto ocupado*.

**Rutas estables en Linux.** `/dev/ttyUSB0` puede renumerarse tras un reinicio o al enchufar
otro adaptador. Usa `/dev/serial/by-id/…`, que identifica el adaptador concreto (la lupa las
muestra primero). En Raspberry Pi, la UART integrada es `/dev/serial0`.

**Permisos.** Si el estado dice *Sin permiso*, añade el usuario que ejecuta Node-RED al grupo
`dialout` (`sudo usermod -aG dialout <usuario>`) y reinicia la sesión. En Docker hay que
pasar el dispositivo al contenedor (`--device /dev/ttyUSB0`).

**Eco local.** Algunos adaptadores USB-RS485 baratos y HATs devuelven por RX lo que
transmiten. Ese eco empieza por `[slave][FC]` igual que la respuesta, así que sin tratarlo
todas las lecturas dan *CRC inválido*. La casilla **eco** del cliente lo descarta.

**Desconexión en caliente.** Si se desenchufa el adaptador USB, el estado pasa a
*Puerto serie desconectado* y el cliente reintenta abrirlo cada 2 s.

---

## Bytes esperados en la respuesta

Para `N` registros la respuesta tiene exactamente:

- **RTU over TCP:** `3 + N × 2 + 2` bytes (slave + FC + byteCount + datos + CRC)
- **Modbus TCP:** `9 + N × 2` bytes (MBAP 7 + FC + byteCount + datos)
- **RTU serie:** igual que RTU over TCP

El panel del nodo Read muestra este valor dinámicamente al editar el campo **Cantidad**,
ajustado al protocolo del cliente seleccionado.

---

## Pruebas

Hay tres suites, una por modo. Todas levantan un esclavo Modbus simulado y ejercitan el
código real del cliente:

| Suite | Qué cubre | Necesita |
|-------|-----------|----------|
| `test/test-excepciones.js` | RTU over TCP | Solo Node.js |
| `test/test-modbus-tcp.js` | Modbus TCP | Solo Node.js |
| `test/test-rtu-serie.js` | RTU por puerto serie | `serialport` (`npm ci`) y `socat` |

```bash
npm ci                     # instala dependencias, incluido serialport
sudo apt install socat     # puertos serie virtuales para la suite serie
npm test                   # las tres suites
npm run test:sin-serie     # solo RTU over TCP y Modbus TCP
```

**`npm test` falla a propósito si la suite serie no puede ejecutarse** (falta `serialport` o
`socat`). Una suite omitida que devolviera éxito dejaría `npm test` en verde sin haber
probado el modo serie. Si en tu entorno no puedes instalar lo necesario, usa
`npm run test:sin-serie`: deja claro qué se ha probado y qué no. La variable
`ROT_OMITIR_SERIE=1` hace lo mismo con `npm test` en shells tipo Unix.

El CI de GitHub instala `socat`, ejecuta `npm ci` y `npm test`, y no empaqueta ni publica
nada si falla alguna suite.

---

## Requisitos

- Node-RED **≥ 2.0.0**
- Node.js **≥ 16.0.0** (requisito de `serialport` 12)

---

## Cambios en 1.2.2

Sin cambios en el código de los nodos: solo pruebas, empaquetado y documentación.

- `package-lock.json` regenerado para que coincida con `package.json` (versión, Node ≥16 y
  `serialport`). El CI instala con `npm ci`, que falla si vuelven a desincronizarse.
- Script `npm run test:sin-serie` para probar los modos TCP donde no se puede instalar
  `serialport` o `socat`. Funciona también en Windows, a diferencia de la variable de entorno.
- Nueva sección [Pruebas](#pruebas) con el comportamiento actual; corregida la nota de la
  1.2.0, que seguía diciendo que la suite serie se saltaba sin fallar.

---

## Cambios en 1.2.1

Correcciones sobre la 1.2.0, todas con prueba de regresión verificada contra el código
anterior (las pruebas nuevas fallan con la 1.2.0 y pasan con la 1.2.1).

- **Cerrar durante un `open()` pendiente daba el puerto por liberado antes de tiempo.**
  `destroy()` se cumplía al instante y el cliente del siguiente deploy recibía *Puerto
  ocupado*. Ahora el cierre espera a que el `open()` termine y el puerto se cierre de verdad.
- **Una configuración serie inválida reintentaba cada 2 s para siempre.** La marca de error
  fatal se ponía en el error original pero se propagaba otro distinto.
- **La suite serie ya no puede quedar en verde sin ejecutarse.** Si faltan `serialport` o
  `socat`, `npm test` falla. Para probar solo los modos TCP: `npm run test:sin-serie`.
- **CI:** el workflow ejecuta las pruebas antes de empaquetar o publicar una release, e
  instala con `npm ci`, que falla si `package-lock.json` no cuadra con `package.json`.
- **`package-lock.json` regenerado:** seguía en una versión antigua, con Node ≥14 y sin
  `serialport`.
- **README:** eliminados los overrides `msg.host`, `msg.port` y `msg.timeout`, que ningún
  nodo implementa; documentado `msg.clientId`, que es el mecanismo real. Corregidos el topic
  de la salida 1 de `rot-read` (`modbus/decimal`), el formato de coils (0/1) y la salida de
  `rot-write`. Quitada la versión de descarga fija.

---

## Cambios en 1.2.0

### Modo Modbus RTU por puerto serie

Tercer modo del cliente. RTU serie y RTU over TCP son **la misma trama**: solo cambia el
medio. Por eso la cola separa ahora dos ejes independientes, *transporte* (TCP / serie) y
*trama* (RTU / MBAP), y el modo serie reutiliza íntegro el parser RTU (resincronización,
excepciones, reensamblado de fragmentos).

Detalles de implementación que conviene conocer:

- **El puerto se cierra con `close()`, no con `destroy()`.** El stream de `serialport` no
  implementa `_destroy`, así que `destroy()` deja el descriptor y el lock del SO tomados y el
  siguiente `open()` falla con *Puerto ocupado*. Hay prueba de regresión para esto.
- **El cierre del nodo espera al cierre físico** (`close(removed, done)`). En un deploy, el
  cliente nuevo abre la misma ruta nada más cerrarse el viejo.
- **Silencio mínimo t3.5** calculado a partir de los baudios.
- **Opción de eco local** para adaptadores que devuelven lo transmitido.
- **Listado de puertos a prueba de contenedores.** En Linux, `SerialPort.list()` ejecuta
  `udevadm`; si no existe (Docker, Alpine) lanza una excepción no capturable que tumbaría
  Node-RED entero. Se comprueba antes y, si falta, se escanea `/dev` a mano.
- **Errores del SO traducidos:** puerto no encontrado, sin permiso (grupo `dialout`),
  puerto ocupado.

### Las peticiones ya no se acumulan sin enlace (afecta a todos los modos)

Antes, si el enlace estaba caído, las peticiones esperaban en cola sin límite (el timeout
solo arranca al enviar). Con un `rot-read` en polling, la cola crecía mientras el equipo
estaba desconectado y al reconectar salía una ráfaga de lecturas viejas. Ahora, al perder
el enlace, todo lo encolado falla al momento por la salida de error, y cada disparo
posterior falla igual hasta que se recupera la conexión. La reconexión automática cada 2 s
se mantiene mientras haya nodos suscritos.

Banco de pruebas nuevo en `test/test-rtu-serie.js` (11 bloques). Usa `socat` para crear un
par de puertos serie virtuales. En esta versión, si faltaba `socat` o `serialport` la suite
se saltaba devolviendo éxito; **desde la 1.2.1 falla**. Ver [Pruebas](#pruebas).

---

## Cambios en 1.1.0

### Soporte de Modbus TCP

El cliente admite ahora los dos protocolos mediante el campo **Modo**. Internamente el
código se reorganizó en tres capas: constructores de PDU y decodificadores de datos
**comunes**, y una capa de envoltorio/extracción específica de cada protocolo. La lógica
RTU (resincronización de cabecera, gestión de excepciones, reensamblado de fragmentos)
queda intacta.

Detalles del modo TCP:

- El **Transaction ID** se asigna en el momento del envío, no al encolar, para que un
  reintento tras reconexión no reutilice un TID viejo.
- Las respuestas rezagadas se descartan por trama completa comparando el TID, en vez de
  byte a byte como en RTU.
- El troceado usa el campo *Length* del MBAP, así que el reensamblado de respuestas
  fragmentadas es determinista.
- Se valida el FC y el `byteCount` de la respuesta, ya que sin CRC son las únicas
  comprobaciones de coherencia disponibles.
- Una cabecera MBAP imposible produce un error inmediato que sugiere revisar el protocolo,
  en lugar de agotar el timeout.

Banco de pruebas nuevo en `test/test-modbus-tcp.js` (9 bloques). `npm test` ejecuta ambas
suites.

---

## Cambios en 1.0.0

Correcciones de robustez sobre el bus Modbus. Ejecuta `npm test` para verificarlas.

### Escrituras rechazadas agotaban el timeout completo (critico)

Una excepcion Modbus ocupa 5 bytes, pero las escrituras se encolaban con
`minBytes: 8`, asi que `_tryParse` cortaba antes de procesarlas y la peticion
esperaba el timeout entero **pese a haber recibido respuesta**. Con un timeout
de 5 s, cada escritura rechazada dejaba el bus parado 5 s y el error se
reportaba como "sin respuesta", ocultando la causa real.

Ahora la excepcion se detecta antes del corte por `minBytes`, para lecturas y
escrituras por igual.

### Las excepciones se reportaban como "Respuesta corta"

En los tres parsers, la comprobacion de longitud iba antes que la del bit de
excepcion, de modo que el mensaje "Excepcion Modbus" era inalcanzable. Se ha
invertido el orden y se ha añadido la descripcion del codigo: el caso mas
comun, el 2, ahora se lee como "direccion de registro ilegal (registro
inexistente en el equipo)" en vez de "Respuesta corta: 5 bytes, esperados 25".

### Sin silencio entre tramas (origen de CRC intermitentes)

La cola encadenaba una transaccion tras otra sin pausa. En RS485 el esclavo
necesita soltar la linea antes de recibir la siguiente peticion, y no dar ese
margen produce errores CRC esporadicos que se agravan cuantos mas esclavos hay.

Se han añadido dos parametros nuevos en el nodo de configuracion: **Normal**
(50 ms por defecto, tras una operacion correcta) y **Tras fallo** (500 ms, tras
CRC o timeout). Las configuraciones existentes adoptan estos valores sin tocar
nada. Subelos si el bus es largo o el conversor es lento.

### El cliente quedaba zombi tras un deploy parcial

`unsubscribe()` llamaba a `destroy()`, que marca `_closed = true`, y
`subscribe()` no revertia el flag. Si Node-RED recreaba los nodos read/write
conservando el de configuracion, el cliente reconectaba pero se quedaba sin
reconexion automatica de forma permanente. `subscribe()` vuelve a abrirlo.

### Otros

- `socket.setTimeout()` no se llamaba nunca, asi que el handler `'timeout'` era
  codigo muerto: un gateway medio-abierto (socket vivo, sin respuestas) no se
  detectaba. Ahora se arma a `timeout * 3` con un minimo de 30 s.
- La reconexion automatica solo se programaba si quedaban peticiones en cola.
  Si el socket caia con el bus en reposo, la siguiente lectura se comia un
  timeout entero. Ahora tambien reconecta si hay nodos suscritos.
- `buf[2]` (byteCount) se acota a 250 antes de usarlo para calcular el tamaño
  esperado: un valor corrupto hacia esperar bytes que no llegaban nunca.
- `_flush()` ya no adelanta un silencio en curso ni escribe sobre un socket que
  aun se esta conectando.
