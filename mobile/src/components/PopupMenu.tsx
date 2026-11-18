import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { colors, themed } from '../theme';

interface PopupMenuProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/** Menu melayang di pojok kanan atas; ketuk di luar menu untuk menutup. */
export const PopupMenu = ({ open, onClose, children }: PopupMenuProps) => (
  <Modal transparent visible={open} animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
      <View style={styles.menu}>{children}</View>
    </Pressable>
  </Modal>
);

export const MenuItem = ({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) => (
  <Pressable accessibilityRole="menuitem" onPress={onPress} style={menuStyles.item}>
    <Text style={{ color: danger ? colors.danger : colors.text }}>{label}</Text>
  </Pressable>
);

export const menuStyles = themed(() => ({
  item: { paddingVertical: 11, paddingHorizontal: 10, borderRadius: 8 },
}));

const styles = themed(() => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.15)', alignItems: 'flex-end', paddingTop: 64, paddingRight: 16 },
  menu: { minWidth: 220, backgroundColor: colors.surface, borderRadius: 12, padding: 6, elevation: 6 },
}));
