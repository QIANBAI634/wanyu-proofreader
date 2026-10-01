<template>
  <div>
    <AppNavbar>
      <template #nav-links>
        <RouterLink to="/workspace" class="nav-link">工作台</RouterLink>
        <RouterLink v-if="auth.isPlatformAdmin || auth.hasManagedProjects" to="/admin" class="nav-link" :class="{ active: isProjectWorkspace }">项目管理</RouterLink>
        <RouterLink v-if="auth.hasProofreadingProjects" to="/tasks" class="nav-link">材料校对</RouterLink>
        <RouterLink to="/projects" class="nav-link">发现项目</RouterLink>
        <RouterLink v-if="auth.canCreateProjects" to="/admin/projects/new" class="nav-link" :class="{ active: route.path === '/admin/projects/new' }">新建项目</RouterLink>
        <RouterLink v-if="auth.isPlatformAdmin" to="/admin/creator-grants" class="nav-link" :class="{ active: route.path === '/admin/creator-grants' }">创建权限</RouterLink>
        <RouterLink v-if="auth.isPlatformAdmin || auth.hasManagedProjects" to="/admin/sources" class="nav-link" :class="{ active: route.path === '/admin/sources' }">来源登记</RouterLink>
        <RouterLink v-if="auth.isPlatformAdmin" to="/admin/gate-rules" class="nav-link" :class="{ active: route.path === '/admin/gate-rules' }">规则门控</RouterLink>
      </template>
    </AppNavbar>
    <RouterView />
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute, RouterView, RouterLink } from 'vue-router'
import AppNavbar from '@/components/AppNavbar.vue'
import { useAuthStore } from '@/stores/auth'
const route = useRoute()
const auth = useAuthStore()
const isProjectWorkspace = computed(() => route.path === '/admin' || (route.path.startsWith('/admin/projects/') && route.path !== '/admin/projects/new'))
onMounted(() => auth.loadAccessContext())
</script>
