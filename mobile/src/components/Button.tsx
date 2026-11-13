import React from 'react';
import { ActivityIndicator, Pressable, Text } from 'react-native';
import { colors, ui } from '../theme';

interface Props {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'plain' | 'danger';
  busy?: boolean;
  disabled?: boolean;
}

export const Button = ({ label, onPress, variant = 'primary', busy, disabled }: Props) => {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={[ui.button, primary ? ui.primary : ui.plain, (disabled || busy) && { opacity: 0.6 }]}>
      {busy ? (
        <ActivityIndicator color={primary ? colors.accentText : colors.accent} />
      ) : (
        <Text style={[primary ? ui.primaryText : ui.plainText, variant === 'danger' && { color: colors.danger }]}>{label}</Text>
      )}
    </Pressable>
  );
};
