#!/usr/bin/env node

import 'any-observable/register/rxjs-all';

import log from 'yalm';
import MQTT from 'mqtt';

import { SenseME } from '@docbliny/haiku-senseme';
import { Observable, Subject } from 'rxjs';

import config from './config.js';

log.setLevel(config.verbosity);

function afterSettled(event, settleTime, callback) {
    this.addListener(event, handleEvent);

    let timeout;
    function handleEvent() {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
            this.removeListener(event, handleEvent);
            timeout = null;
            callback();
        }, settleTime);
    }
}

SenseME
    .setConfig({ broadcastAddress: config.send_address})
    .on('founddevice', (device) => {
        afterSettled.call(device.listenAll(), 'change', 100, () => { setupNewDevice(device) });
    })
    .on('lostdevice',  forgetDevice)
    .discover();

let clients = { };
let subjects = { };

const STATUS_OPTS = { qos: 2, retain: true };

function getTopic(dev, suffix) {
    return `${config.name}_${formatDeviceId(dev)}/${suffix}`;
}

function setupNewDevice(device) {
    log.debug(`Creating client for ${device.name}`);
    let client;
    if (!clients[device.id]) {
        clients[device.id] = client = MQTT.connect(config.broker, {
            will: {
                topic:   getTopic(device, 'connected'),
                payload: '0',
                ...STATUS_OPTS
            }
        });
    }

    // HACK: Fix what seems like a race condition: https://github.com/forty2/haiku2mqtt/issues/2
    if(!client) {
        log.debug('setupNewDevice: Client is no longer valid, skipping...');
        return;
    }

    sendHomeAssistantDiscovery(client, device);
    client.publish(getTopic(device, 'connected'), '2', STATUS_OPTS);

    // observe all property changes for this device until it disappears.
    subjects[device.id] = new Subject();

    device.observeAll()
        .takeUntil(subjects[device.id])
        .map(({ path, value }) => ({
            topic: getTopic(device, ['status'].concat(path).join('/')),
            message: value,
            client,
            retain: true
        }))
        ::publishMessages();

    // force a refresh in case we didn't subscribe early enough to get the
    // automatic one.
    device.refreshAll();

    getMessages(client, getTopic(device, 'set/#'), getTopic(device, 'get/#'))
        .catch((_, caught) => caught)
        .subscribe(({ topic, message }) => {
            let match = topic.match(/([sg]et)\/(.*)$/);
            if (match) {
                let path = match[2].split('/'), command = match[1];
                let obj =
                    path.reduce(
                        (acc, x) => x in acc ? acc[x] : undefined
                    , device);

                if (typeof obj !== 'undefined') {
                    // if a value can't be set, don't bother trying.
                    // Likewise, there's no sense refreshing a value that
                    // can't change.
                    let desc = Object.getOwnPropertyDescriptor(obj, 'value');
                    if (desc.set) {
                        if (command === 'set') {
                                log.debug(`Setting ${device.name},${path} from ${obj.value} to ${message}`);
                                obj.value = message;
                        }
                        else if (command === 'get') {
                            // request an update.  The new value will eventually
                            // be published on the status channel.
                            obj.refresh();
                        }
                    }
                }
            }
        })
}

function forgetDevice(device) {
    if(!clients[device.id]) {
        return;
    }

    clients[device.id].publish(getTopic(device, 'connected'), '1', STATUS_OPTS);

    subjects[device.id].next();
    subjects[device.id] = undefined;
}

function publishMessage({ topic, message, client, retain }) {
    if(client) {
        client.publish(topic, message !== null ? message.toString() : null, { qos: 2, retain });
    }
}

function NOOP() { }
function publishMessages(onError = NOOP, onComplete = NOOP) {
    return this.subscribe(
        publishMessage,
        onError,
        onComplete
    );
}

function sendHomeAssistantDiscovery(client, device) {
    if(!client || !device) {
        log.debug('sendHomeAssistantDiscovery: Missing client or device.');
        return;
    }

    log.debug(`Sending auto-discovery for device '${device.name}', type '${device.type}'`);

    let configInfo;

    // Add fan
    if(device.type.includes('FAN') === true) {
        configInfo = {
            name: device.name,
            command_topic: `haiku_${formatDeviceId(device)}/set/fan/power`,
            state_topic: `haiku_${formatDeviceId(device)}/status/fan/power`,
            speed_command_topic: `haiku_${formatDeviceId(device)}/status/fan/speed`,
            speed_state_topic: `haiku_${formatDeviceId(device)}/status/fan/speed`,
            payload_on: 'on',
            payload_off: 'off',
            payload_low_speed: '3',
            payload_medium_speed: '5',
            payload_high_speed: '7',
            speeds: [ 'off', 'low', 'medium', 'high' ],
        };

        // Send
        client.publish(`homeassistant/fan/haiku_${formatDeviceId(device)}/config`, JSON.stringify(configInfo), STATUS_OPTS);

        // Add fan sensor
        configInfo = {
            name: device.name,
            state_topic: `haiku_${formatDeviceId(device)}/status/sensor/isRoomOccupied`,
            payload_on: 'true',
            payload_off: 'false',
            device_class: 'occupancy',
        };

        // Send
        client.publish(`homeassistant/binary_sensor/haiku_${formatDeviceId(device)}/config`, JSON.stringify(configInfo), STATUS_OPTS);

        // Add light if one exists on the device
        if(device.device.hasLight.value === true) {
            configInfo = {
                name: device.name,
                command_topic: `haiku_${formatDeviceId(device)}/set/light/power`,
                state_topic: `haiku_${formatDeviceId(device)}/status/light/power`,
                payload_on: 'on',
                payload_off: 'off',
                brightness_state_topic: `haiku_${formatDeviceId(device)}/status/light/brightness`,
                brightness_command_topic: `haiku_${formatDeviceId(device)}/set/light/brightness`,
                brightness_scale: 16,
                on_command_type: 'brightness',
            };

            // Send
            client.publish(`homeassistant/light/haiku_${formatDeviceId(device)}/config`, JSON.stringify(configInfo), STATUS_OPTS);
        }
    } else if(device.type.includes('SWITCH') === true) {
        // Add fan sensor
        configInfo = {
            name: device.name,
            state_topic: `haiku_${formatDeviceId(device)}/status/sensor/isRoomOccupied`,
            payload_on: 'true',
            payload_off: 'false',
            device_class: 'occupancy',
        };

        // Send
        client.publish(`homeassistant/binary_sensor/haiku_${formatDeviceId(device)}/config`, JSON.stringify(configInfo), STATUS_OPTS);
    }

}

function formatDeviceId(device) {
    if(device && device.id) {
        return device.id.replace(/:/g, "");
    } else {
        log.error("Invalid device or ID", device);
        return "";
    }

}

function getMessages(client, ...topics) {
    return new Observable(
        subscriber => {
            client.subscribe(topics);
            client.on('message', (m_topic, msg) => {
                subscriber.next({
                    topic: m_topic,
                    message: msg.toString()
                })
            });

            return () => {
                client.unsubscribe(topics);
            }
        }
    );
}
