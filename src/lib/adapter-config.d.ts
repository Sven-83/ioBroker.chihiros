// This file extends the AdapterConfig type from "@iobroker/types"

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** ESPHome Bluetooth proxy (host or IP) */
            proxyHost: string;
            /** Noise key of the proxy API (base64, encrypted) */
            proxyKey: string;
            /** Configured Chihiros devices */
            devices: Array<{
                /** Display name, also used for the object ID */
                name: string;
                /** Device type: light, doser, co2, doctor, fan */
                type: string;
                /** Bluetooth MAC address XX:XX:XX:XX:XX:XX */
                mac: string;
                /** Only in use part of the year (e.g. the fan in summer): no warning when it is missing */
                seasonal: boolean;
            }>;
            /** A device counts as missing when it has not been heard for this many minutes */
            seenMinutes: number;
        }
    }
}

export {};
