import React from 'react';
import { Text, View } from 'react-native';

interface Props {
  name: string;
  /** Warna tetap per seed (username) agar tiap orang mudah dikenali. */
  seed?: string;
  size?: number;
}

const initialsOf = (name: string) =>
  name
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]!.toUpperCase())
    .join('') || '?';

const hueOf = (seed: string) => [...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;

export const Avatar = ({ name, seed, size = 44 }: Props) => (
  <View
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: `hsl(${hueOf(seed ?? name)}, 42%, 42%)`,
    }}>
    <Text style={{ color: '#fff', fontWeight: '600', fontSize: Math.round(size * 0.38) }}>{initialsOf(name)}</Text>
  </View>
);
