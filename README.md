<img src="./icons/rot.png" width="32" height="32">
<img src="https://cdn.worldvectorlogo.com/logos/node-red-1.svg" width="32" height="32"> node-red-contrib-rtu-over-tcp

**Autor:** Daniel Sierra  
**Descripción:** Nodos Node-RED para leer y escribir registros Modbus usando **RTU over TCP**

---

Frame RTU completo con CRC16 sobre socket TCP raw.  
Conexión TCP **persistente con reconexión automática** y cola de peticiones serializada.  
Compatible con: Ibercon RS485.

---

## Instalación del paquete

Este paquete se distribuye como un archivo `.tgz`. A continuación, se detallan las formas de descarga e instalación.

### 1. Descargar el paquete

1. Ir a la pestaña **Releases** del repositorio
2. Seleccionar la versión **v1.0.0**
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

| Salida | `msg.topic`     | `msg.payload`                                                       | Notas                          |
|--------|-----------------|---------------------------------------------------------------------|--------------------------------|
| 1      | `modbus/boolean`| Array de booleanos (para FC01/FC02) o int16 con signo (para FC03/FC04) | Incluye `msg.timestamp` ISO 8601 |
| 2      | `modbus/hex`    | Array de strings. `msg.payload[N]` = `"0xXXXX"` (FC03/FC04)            | Incluye `msg.timestamp` ISO 8601 |
| 3      | —               | `null`                                                              | `msg.error` = descripción del fallo |

### rot-write

| Salida | `msg.topic`   | `msg.payload`                              | Notas                          |
|--------|---------------|--------------------------------------------|--------------------------------|
| 1      | `modbus/write`| Objeto con `reg`, `count` y `value`        | Incluye `msg.timestamp` ISO 8601 |
| 2      | —             | `null`                                     | `msg.error` = descripción del fallo |

---

## Sobreescribir parámetros por mensaje

Los siguientes campos en el mensaje de entrada sobreescriben temporalmente la configuración del panel:

### Para rot-read

```javascript
msg.host     = "192.168.1.50";  // nueva IP (crea conexión temporal)
msg.port     = 502;             // nuevo puerto (crea conexión temporal)
msg.deviceId = 3;               // nuevo Slave ID
msg.fc       = 3;              // 1 = FC01, 2 = FC02, 3 = FC03, 4 = FC04
msg.startReg = 100;            // nuevo registro inicial
msg.count    = 20;             // nueva cantidad de registros
msg.timeout  = 3;              // nuevo timeout en segundos
```

### Para rot-write

```javascript
msg.host     = "192.168.1.50";  // nueva IP (crea conexión temporal)
msg.port     = 502;             // nuevo puerto (crea conexión temporal)
msg.deviceId = 3;              // nuevo Slave ID
msg.fc       = 16;             // 5 = FC05, 6 = FC06, 15 = FC15, 16 = FC16
msg.startReg = 100;            // nuevo registro inicial
msg.payload = [1, 2, 3, 4];    // valores a escribir ( requerido para FC15/FC16)
msg.payload = 1234;            // valor único (para FC05/FC06)
```

> **Nota:** Si `msg.host` o `msg.port` difieren de la configuración del nodo, se crea una conexión TCP temporal solo para esa operación.

---

## Funciones Modbus soportadas

| Código | Función | Descripción              | Payload de entrada        | Salida               |
|--------|---------|-------------------------|-------------------------|----------------------|
| FC01   | Read Coil Inputs       | Lee coils (bits)         | —                     | array de booleanos     |
| FC02   | Read Discrete Inputs  | Lee entradas discretas | —                     | array de booleanos   |
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

## Bytes esperados en la respuesta

Para `N` registros la respuesta RTU tiene exactamente `3 + N × 2 + 2` bytes.  
El panel muestra este valor dinámicamente al editar el campo **Cantidad**.

---

## Requisitos

- Node-RED **≥ 2.0.0**
- Node.js **≥ 14.0.0**

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
