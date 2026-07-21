import { StyleSheet, View } from 'react-native';

const bars = [18, 30, 44, 26, 58, 36, 50, 22, 42, 62, 32, 48, 24, 38, 54, 28];

export function Waveform({
  active,
  color = '#FFFFFF',
}: {
  active: boolean;
  color?: string;
}) {
  return (
    <View accessibilityElementsHidden style={styles.row}>
      {bars.map((height, index) => (
        <View
          key={`${height}-${index}`}
          style={[
            styles.bar,
            {
              backgroundColor: color,
              height: active ? height : Math.max(5, height * 0.22),
              opacity: active ? 0.28 + ((index * 13) % 56) / 100 : 0.2,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    height: 70,
    justifyContent: 'center',
  },
  bar: {
    borderRadius: 99,
    width: 3,
  },
});
