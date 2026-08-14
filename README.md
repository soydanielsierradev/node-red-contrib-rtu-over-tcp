<p align="center">
  <img src="./icons/rot.png" width="90" height="90" alt="Modbus">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="https://cdn.worldvectorlogo.com/logos/node-red-1.svg" width="90" height="90" alt="Node-RED">
</p>

<h1 align="center">node-red-contrib-rtu-over-tcp</h1>

<p align="center">
  <b>Author:</b> Daniel Sierra<br>
  <b>Description:</b> Node-RED nodes to read and write Modbus registers over <b>RTU over TCP</b>
</p>

---

Full RTU frame with CRC16 over a raw TCP socket.  
**Persistent TCP connection with automatic reconnection** and a serialized request queue.  
Compatible with: Ibercon RS485.

---

## Package installation

This package is distributed as a `.tgz` file. The download and installation steps are described below.

### 1. Download the package

1. Go to the **Releases** tab of the repository
2. Select version **v1.0.0**
3. Download the attached `.tgz` file

### 2. Install in Node-RED

1. Open Node-RED
2. Go to: Menu → Manage Palette → Install
3. Select Upload
4. Choose the `.tgz` file
5. Confirm the installation

---

## Available nodes

| Node | Description |
|------|-------------|
| **rot-client** | Configuration node. Manages the TCP connection and the request queue. |
| **rot-read** | Reads Modbus coils and registers (FC01, FC02, FC03, FC04). |
| **rot-write** | Writes Modbus registers (FC05, FC06, FC15, FC16). |

---

## Configuration

### ROT Client (configuration node)

| Field    | Description                                    | Example       |
|----------|------------------------------------------------|---------------|
| Name     | Optional label for the node                    | My gateway    |
| IP / Host| IP address or hostname of the TCP converter    | 192.168.1.100 |
| Port     | TCP port of the converter                      | 502           |
| Timeout  | Maximum wait time for a response, in seconds   | 5             |

> **Note:** Every `rot-read` and `rot-write` node must select an existing `ROT Client`.

### ROT Read

| Field           | Description                                                          | Example       |
|-----------------|----------------------------------------------------------------------|---------------|
| Name            | Optional label for the node                                          | My sensor     |
| ROT Client      | Shared configuration node                                            | (selection)   |
| Use with Inject | Checked: input pin visible. Unchecked: button embedded in the node   | ✓             |
| Slave ID        | Device ID on the RS485 bus                                           | 5             |
| Function        | FC01 Read Coil / FC02 Read Discrete Input / FC03 Holding / FC04 Input | FC04          |
| Start reg.      | Address of the first register (base 0)                               | 0             |
| Count           | Number of registers to read                                         | 45            |
| Interval        | Seconds between automatic reads. `0` = trigger only                  | 1             |

### ROT Write

| Field       | Description                                                          | Example       |
|-------------|----------------------------------------------------------------------|---------------|
| Name        | Optional label for the node                                         | Writer        |
| ROT Client  | Shared configuration node                                          | (selection)   |
| Function    | FC05 Write Single Coil / FC06 Write Single Register / FC15 Write Multiple Coils / FC16 Write Multiple Registers | FC16 |
| Slave ID    | Device ID on the RS485 bus                                          | 5             |
| Start reg.  | Address of the first register (base 0)                             | 0             |
| Value       | Fixed value for FC05/FC06 (optional, can be sent via msg.payload)  | 1234          |
| Values      | JSON array of values for FC15/FC16 (optional)                      | `[1,0,1,1]`   |

---

## Trigger modes (rot-read)

| Mode | Description |
|------|-------------|
| **External Inject** | `Use with Inject` checked. The node exposes an input pin. Connect an Inject, Change or any other trigger node. |
| **Embedded button** | `Use with Inject` unchecked. The node has its own button (same as the native Inject node). No input pin needed. |
| **Automatic polling** | `Interval > 0`. The node fires periodic reads regardless of the trigger mode. |
| **Stop polling** | Send `msg.stop = true` to the node input at any time. |

---

## Outputs

### rot-read

| Output | `msg.topic`     | `msg.payload`                                                        | Notes                          |
|--------|-----------------|---------------------------------------------------------------------|--------------------------------|
| 1      | `modbus/boolean`| Array of booleans (for FC01/FC02) or signed int16 (for FC03/FC04)   | Includes `msg.timestamp` ISO 8601 |
| 2      | `modbus/hex`    | Array of strings. `msg.payload[N]` = `"0xXXXX"` (FC03/FC04)          | Includes `msg.timestamp` ISO 8601 |
| 3      | —               | `null`                                                              | `msg.error` = failure description |

### rot-write

| Output | `msg.topic`   | `msg.payload`                              | Notes                          |
|--------|---------------|--------------------------------------------|--------------------------------|
| 1      | `modbus/write`| Object with `reg`, `count` and `value`     | Includes `msg.timestamp` ISO 8601 |
| 2      | —             | `null`                                     | `msg.error` = failure description |

---

## Overriding parameters per message

The following fields in the input message temporarily override the panel configuration:

### For rot-read

```javascript
msg.host     = "192.168.1.50";  // new IP (creates a temporary connection)
msg.port     = 502;             // new port (creates a temporary connection)
msg.deviceId = 3;               // new Slave ID
msg.fc       = 3;               // 1 = FC01, 2 = FC02, 3 = FC03, 4 = FC04
msg.startReg = 100;             // new start register
msg.count    = 20;              // new register count
msg.timeout  = 3;               // new timeout in seconds
```

### For rot-write

```javascript
msg.host     = "192.168.1.50";  // new IP (creates a temporary connection)
msg.port     = 502;             // new port (creates a temporary connection)
msg.deviceId = 3;               // new Slave ID
msg.fc       = 16;              // 5 = FC05, 6 = FC06, 15 = FC15, 16 = FC16
msg.startReg = 100;             // new start register
msg.payload  = [1, 2, 3, 4];    // values to write (required for FC15/FC16)
msg.payload  = 1234;            // single value (for FC05/FC06)
```

> **Note:** If `msg.host` or `msg.port` differ from the node configuration, a temporary TCP connection is created just for that operation.

---

## Supported Modbus functions

| Code | Function | Description              | Input payload             | Output               |
|------|----------|--------------------------|---------------------------|----------------------|
| FC01 | Read Coils              | Reads coils (bits)       | —                     | array of booleans    |
| FC02 | Read Discrete Inputs    | Reads discrete inputs    | —                     | array of booleans    |
| FC03 | Read Holding Registers  | Reads registers (int16)  | —                     | array of int16       |
| FC04 | Read Input Registers    | Reads input registers    | —                     | array of int16       |
| FC05 | Write Single Coil       | `true/false` or `0/1`    | `msg.payload`             | —                    |
| FC06 | Write Single Register   | number (int16)           | `msg.payload`             | —                    |
| FC15 | Write Multiple Coils    | array of booleans        | `msg.payload = [...]`     | —                    |
| FC16 | Write Multiple Registers| array of numbers         | `msg.payload = [...]`     | —                    |

---

## TCP connection behavior

The `rot-client` node keeps a **persistent TCP connection** with the converter:

- It connects on the first trigger, or on startup if polling is active.
- Requests are queued and executed serially (one at a time), avoiding collisions on the RS485 bus.
- On an unexpected disconnect, the in-flight request receives an error and the node retries the connection automatically after **2 seconds** if there are pending requests.
- When the node closes (deploy / restart), the connection is closed cleanly.
- The status indicator reflects the state in real time: `idle` → `connected` → `reading…` → `ok` / `error`.

---

## Expected response bytes

For `N` registers the RTU response is exactly `3 + N × 2 + 2` bytes.  
The panel shows this value dynamically as you edit the **Count** field.

---

## Requirements

- Node-RED **≥ 2.0.0**
- Node.js **≥ 14.0.0**

---

## Changes in 1.0.0

Robustness fixes on the Modbus bus. Run `npm test` to verify them.

### Rejected writes exhausted the full timeout (critical)

A Modbus exception is 5 bytes, but writes were queued with `minBytes: 8`, so
`_tryParse` cut off before processing them and the request waited out the whole
timeout **even though a response had been received**. With a 5 s timeout, each
rejected write left the bus idle for 5 s and the error was reported as "no
response", hiding the real cause.

The exception is now detected before the `minBytes` cutoff, for reads and
writes alike.

### Exceptions were reported as "Short response"

In all three parsers, the length check ran before the exception-bit check, so
the "Modbus exception" message was unreachable. The order has been swapped and
the code description added: the most common one, code 2, now reads as "illegal
register address (register not present on the device)" instead of "Short
response: 5 bytes, expected 25".

### No silence between frames (source of intermittent CRC errors)

The queue chained one transaction after another with no pause. On RS485 the
slave needs to release the line before receiving the next request, and not
giving it that margin produces sporadic CRC errors that get worse the more
slaves there are.

Two new parameters were added to the configuration node: **Normal** (50 ms by
default, after a successful operation) and **After failure** (500 ms, after a
CRC error or timeout). Existing configurations adopt these values without any
changes. Raise them if the bus is long or the converter is slow.

### The client became a zombie after a partial deploy

`unsubscribe()` called `destroy()`, which sets `_closed = true`, and
`subscribe()` did not revert the flag. If Node-RED recreated the read/write
nodes while keeping the configuration node, the client reconnected but was
left permanently without automatic reconnection. `subscribe()` now reopens it.

### Other

- `socket.setTimeout()` was never called, so the `'timeout'` handler was dead
  code: a half-open gateway (live socket, no responses) went undetected. It is
  now armed to `timeout * 3` with a minimum of 30 s.
- Automatic reconnection was only scheduled if requests remained in the queue.
  If the socket dropped while the bus was idle, the next read ate a full
  timeout. It now also reconnects if there are subscribed nodes.
- `buf[2]` (byteCount) is clamped to 250 before being used to compute the
  expected size: a corrupt value made it wait for bytes that never arrived.
- `_flush()` no longer skips an in-progress silence nor writes to a socket that
  is still connecting.
