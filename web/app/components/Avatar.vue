<script setup lang="ts">
// Lingkaran inisial; warna tetap per seed (username) agar tiap orang mudah dikenali.
const props = withDefaults(defineProps<{ name: string; seed?: string; size?: number }>(), { seed: undefined, size: 44 })

const initials = computed(
  () =>
    props.name
      .split(/[\s_]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || '?',
)
const hue = computed(() => [...(props.seed ?? props.name)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360)
</script>

<template>
  <span
    class="avatar"
    aria-hidden="true"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      fontSize: `${Math.round(size * 0.38)}px`,
      background: `linear-gradient(145deg, hsl(${hue} 46% 46%), hsl(${(hue + 24) % 360} 48% 36%))`,
    }"
  >{{ initials }}</span>
</template>

<style scoped>
.avatar {
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: 50%;
  color: #fff;
  font-weight: 600;
  letter-spacing: .02em;
  user-select: none;
}
</style>
