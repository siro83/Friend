import * as React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { rotateImage } from '../modules/imaging';
import { toBase64Image } from '../utils/base64';
import { Agent } from '../agent/Agent';
import { InvalidateSync } from '../utils/invalidateSync';
import { textToSpeech } from '../modules/openai';

function usePhotos(device: BluetoothRemoteGATTServer) {

    // Subscribe to device
    const [photos, setPhotos] = React.useState<Array<{ data: Uint8Array; timestamp: number }>>([]);
    const [subscribed, setSubscribed] = React.useState<boolean>(false);
    React.useEffect(() => {
        (async () => {

            let buffer: Uint8Array = new Uint8Array(0);
            let nextExpectedFrame = 0;
            let isTransferring = false;

            // Subscribe for photo updates
            const service = await device.getPrimaryService('19B10000-E8F2-537E-4F6C-D104768A1214'.toLowerCase());
            const photoCharacteristic = await service.getCharacteristic('19b10005-e8f2-537e-4f6c-d104768a1214');
            await photoCharacteristic.startNotifications();
            setSubscribed(true);
            photoCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
                let value = (e.target as BluetoothRemoteGATTCharacteristic).value!;
                if (value.byteLength < 2) {
                    return; // Invalid chunk
                }
                let chunk = new Uint8Array(value.buffer);
                const frameIndex = chunk[0] | (chunk[1] << 8);

                // End of image marker (0xFFFF)
                if (frameIndex === 0xFFFF) {
                    if (isTransferring && buffer.length > 0) {
                        console.log('Complete JPEG received:', buffer.length, 'bytes');
                        const timestamp = Date.now();
                        const completeImage = buffer;

                        // Process the complete image.
                        rotateImage(completeImage, '270').then((rotated) => {
                            console.log('Rotated photo', rotated.length);
                            setPhotos((p) => [...p, { data: rotated, timestamp: timestamp }]);
                        });
                    }
                    // Reset for the next image.
                    buffer = new Uint8Array(0);
                    isTransferring = false;
                    nextExpectedFrame = 0;
                    return;
                }

                // First chunk of a new image (frame index 0)
                if (frameIndex === 0) {
                    buffer = new Uint8Array(0);
                    isTransferring = true;
                    nextExpectedFrame = 0;
                }

                // If not transferring, ignore packets until a start frame is received.
                if (!isTransferring) {
                    console.log(`Ignoring packet with frame ${frameIndex}, waiting for frame 0.`);
                    return;
                }

                // Check for correct frame order
                if (frameIndex === nextExpectedFrame) {
                    if (chunk.length > 2) {
                        const imageData = chunk.slice(2);
                        const newBuffer = new Uint8Array(buffer.length + imageData.length);
                        newBuffer.set(buffer);
                        newBuffer.set(imageData, buffer.length);
                        buffer = newBuffer;
                    }
                    nextExpectedFrame++;
                } else {
                    console.error(`Frame out of order. Expected ${nextExpectedFrame}, got ${frameIndex}. Discarding image.`);
                    buffer = new Uint8Array(0);
                    isTransferring = false;
                    nextExpectedFrame = 0;
                }

                // Safety break for oversized buffer
                if (buffer.length > 200 * 1024) {
                    console.error("Buffer size exceeded 200KB without a complete image. Resetting.");
                    buffer = new Uint8Array(0);
                    isTransferring = false;
                    nextExpectedFrame = 0;
                }
            });
            // Start automatic photo capture every 5s
            const photoControlCharacteristic = await service.getCharacteristic('19b10006-e8f2-537e-4f6c-d104768a1214');
            await photoControlCharacteristic.writeValue(new Uint8Array([0x05]));
        })();
    }, []);

    return [subscribed, photos] as const;
}

export const DeviceView = React.memo((props: { device: BluetoothRemoteGATTServer }) => {
    const [subscribed, photos] = usePhotos(props.device);
    const agent = React.useMemo(() => new Agent(), []);
    const agentState = agent.use();
    const [activePhotoIndex, setActivePhotoIndex] = React.useState<number | null>(null);

    // Background processing agent
    const processedPhotos = React.useRef<Uint8Array[]>([]);
    const sync = React.useMemo(() => {
        let processed = 0;
        return new InvalidateSync(async () => {
            if (processedPhotos.current.length > processed) {
                let unprocessed = processedPhotos.current.slice(processed);
                processed = processedPhotos.current.length;
                await agent.addPhoto(unprocessed);
            }
        });
    }, []);
    React.useEffect(() => {
        processedPhotos.current = photos.map(p => p.data);
        sync.invalidate();
    }, [photos]);

    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {/* Display photos in a grid filling the screen */}
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#111' }}>
                <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', padding: 5 }}>
                    {photos.slice().reverse().map((photo, index) => ( // Display newest first
                        <Pressable
                            key={photos.length - 1 - index} // Use original index for key stability if needed
                            onPressIn={() => setActivePhotoIndex(photos.length - 1 - index)}
                            onPressOut={() => setActivePhotoIndex(null)}
                            style={{
                                position: 'relative',
                                width: '33%', // Roughly 3 images per row
                                aspectRatio: 1, // Make images square
                                padding: 2 // Add spacing
                            }}
                        >
                            <Image style={{ width: '100%', height: '100%', borderRadius: 5 }} source={{ uri: toBase64Image(photo.data) }} />
                            {activePhotoIndex === (photos.length - 1 - index) && (
                                <View style={{
                                    position: 'absolute',
                                    bottom: 2, // Adjusted for padding
                                    left: 2,
                                    right: 2,
                                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                                    paddingVertical: 3,
                                    paddingHorizontal: 5,
                                    alignItems: 'center',
                                    borderRadius: 3
                                }}>
                                    <Text style={{ color: 'white', fontSize: 10 }}>
                                        {new Date(photo.timestamp).toLocaleTimeString()}
                                    </Text>
                                </View>
                            )}
                        </Pressable>
                    ))}
                </ScrollView>
            </View>
        </View>
    );
});
