<script setup lang="ts">
/**
 * Hierarchical checkbox tree for selecting Orbit models within granted projects.
 * Loads models via orbitApi.models(target, projectId) when projects change.
 */
import { computed, ref, watch } from 'vue';
import Icon from '../../../shared/Icon.vue';
import { orbitApi, type OrbitModel, type OrbitProject } from '../../../shared/api';

const props = defineProps<{
  projects: OrbitProject[];
  projectIds: string[];
  orbitTarget: 'prod' | 'dev';
  modelValue: string[];
}>();

const emit = defineEmits<{
  'update:modelValue': [string[]];
}>();

const filter = ref('');
const loading = ref(false);
const error = ref<string | null>(null);
const expanded = ref<Set<string>>(new Set());
/** projectId → models */
const modelsByProject = ref<Record<string, OrbitModel[]>>({});

const selected = computed({
  get: () => new Set(props.modelValue),
  set: (next: Set<string>) => emit('update:modelValue', [...next]),
});

const grantedProjects = computed(() => {
  const ids = new Set(props.projectIds);
  return props.projects
    .filter((p) => ids.has(p.id))
    .slice()
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
});

watch(
  () => [props.orbitTarget, props.projectIds.join(',')] as const,
  async () => {
    loading.value = true;
    error.value = null;
    const next: Record<string, OrbitModel[]> = {};
    try {
      await Promise.all(
        props.projectIds.map(async (pid) => {
          try {
            const res = await orbitApi.models(props.orbitTarget, pid, 200);
            next[pid] = res.items ?? [];
          } catch (err) {
            next[pid] = [];
            error.value = err instanceof Error ? err.message : 'Failed to load models';
          }
        }),
      );
      modelsByProject.value = next;
      const expand = new Set(expanded.value);
      for (const pid of props.projectIds) expand.add(`p-${pid}`);
      expanded.value = expand;
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

const q = computed(() => filter.value.trim().toLowerCase());

function projectLabel(p: OrbitProject): string {
  return p.name?.trim() || p.id;
}

function modelLabel(m: OrbitModel): string {
  return m.displayName?.trim() || m.name?.trim() || m.id;
}

function filteredModels(projectId: string): OrbitModel[] {
  const list = modelsByProject.value[projectId] ?? [];
  const needle = q.value;
  if (!needle) return list;
  return list.filter((m) => {
    const label = modelLabel(m).toLowerCase();
    return label.includes(needle) || m.id.toLowerCase().includes(needle);
  });
}

function isExpanded(id: string): boolean {
  return expanded.value.has(id);
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function leafChecked(modelId: string): boolean {
  return selected.value.has(modelId);
}

function setLeaf(modelId: string, on: boolean) {
  const next = new Set(selected.value);
  if (on) next.add(modelId);
  else next.delete(modelId);
  selected.value = next;
}

function groupState(projectId: string): 'all' | 'some' | 'none' {
  const models = filteredModels(projectId);
  if (!models.length) return 'none';
  let n = 0;
  for (const m of models) {
    if (selected.value.has(m.id)) n += 1;
  }
  if (n === 0) return 'none';
  if (n === models.length) return 'all';
  return 'some';
}

function setGroup(projectId: string, on: boolean) {
  const next = new Set(selected.value);
  for (const m of filteredModels(projectId)) {
    if (on) next.add(m.id);
    else next.delete(m.id);
  }
  selected.value = next;
}

function bindIndeterminate(el: unknown, some: boolean) {
  if (el instanceof HTMLInputElement) el.indeterminate = some;
}
</script>

<template>
  <div class="model-tree">
    <div class="model-tree__filter">
      <Icon name="search" :size="16" />
      <input
        v-model="filter"
        type="search"
        placeholder="Filter models…"
        autocomplete="off"
      />
    </div>

    <p v-if="!projectIds.length" class="model-tree__empty muted">
      Select at least one project first.
    </p>
    <p v-else-if="loading" class="model-tree__empty muted">Loading models…</p>
    <p v-else-if="error" class="model-tree__empty muted">{{ error }}</p>
    <ul v-else class="model-tree__list" role="tree">
      <li
        v-for="p in grantedProjects"
        :key="p.id"
        class="model-tree__group"
        role="treeitem"
        :aria-expanded="isExpanded(`p-${p.id}`)"
      >
        <div class="model-tree__row">
          <button
            type="button"
            class="model-tree__twist"
            :aria-label="isExpanded(`p-${p.id}`) ? 'Collapse' : 'Expand'"
            @click="toggleExpand(`p-${p.id}`)"
          >
            <Icon :name="isExpanded(`p-${p.id}`) ? 'expand_more' : 'chevron_right'" :size="16" />
          </button>
          <label class="model-tree__check">
            <input
              type="checkbox"
              :checked="groupState(p.id) === 'all'"
              :ref="(el) => bindIndeterminate(el, groupState(p.id) === 'some')"
              @change="setGroup(p.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="model-tree__label">{{ projectLabel(p) }}</span>
            <span class="muted small">{{ filteredModels(p.id).length }}</span>
          </label>
        </div>
        <ul v-if="isExpanded(`p-${p.id}`)" class="model-tree__children" role="group">
          <li v-if="!filteredModels(p.id).length" class="muted small pad">No models</li>
          <li
            v-for="m in filteredModels(p.id)"
            :key="m.id"
            class="model-tree__leaf"
            role="treeitem"
          >
            <label class="model-tree__check model-tree__check--leaf">
              <input
                type="checkbox"
                :checked="leafChecked(m.id)"
                @change="setLeaf(m.id, ($event.target as HTMLInputElement).checked)"
              />
              <span class="model-tree__label">{{ modelLabel(m) }}</span>
              <code class="muted small">{{ m.id }}</code>
            </label>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.model-tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.model-tree__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 6px;
  background: var(--color-bg, transparent);
}
.model-tree__filter input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
}
.model-tree__list,
.model-tree__children {
  list-style: none;
  margin: 0;
  padding: 0;
}
.model-tree__list {
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 6px;
  padding: 4px 0;
}
.model-tree__children {
  padding-left: 28px;
}
.model-tree__row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.model-tree__twist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 4px;
}
.model-tree__twist:hover { background: var(--color-bg-hover, rgba(0,0,0,.06)); }
.model-tree__check {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 5px 10px 5px 4px;
  font-size: 13px;
  cursor: pointer;
}
.model-tree__check--leaf { padding-left: 4px; }
.model-tree__label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.model-tree__check code {
  margin-left: auto;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
.model-tree__empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  border: 1px dashed var(--color-border, var(--border));
  border-radius: 6px;
}
.pad { padding: 6px 10px; }
.small { font-size: 11px; }
</style>
