import { createRouter, createWebHistory } from 'vue-router'
import pb from '@/lib/pocketbase'
import { authState, homePath, resolveNavigation } from '../lib/access.js'

function getAuthState() {
  return authState({ isValid: pb.authStore.isValid, model: pb.authStore.model })
}

// 登录后该去哪里
function getHomePath() {
  return homePath(getAuthState())
}

const routes = [
  {
    path: '/workspace',
    name: 'WorkspaceHome',
    component: () => import('@/views/WorkspaceHomeView.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/',
    redirect: () => getHomePath()
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { guest: true }
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { guest: true }
  },
  {
    path: '/change-password',
    name: 'ChangeInitialPassword',
    component: () => import('@/views/ChangeInitialPasswordView.vue'),
    meta: { requiresAuth: true, allowInitialPassword: true }
  },
  {
    path: '/admin',
    component: () => import('@/views/admin/AdminLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'AdminDashboard',
        component: () => import('@/views/admin/DashboardView.vue')
      },
      {
        path: 'projects/new',
        name: 'NewProject',
        component: () => import('@/views/admin/NewProjectView.vue')
      },
      {
        path: 'guide/project-files',
        name: 'ProjectFilesGuide',
        component: () => import('@/views/admin/ProjectFilesGuideView.vue')
      },
      {
        path: 'projects/:id',
        name: 'ProjectDetail',
        component: () => import('@/views/admin/ProjectDetailView.vue')
      },
      {
        path: 'projects/:id/settings',
        name: 'ProjectSettings',
        component: () => import('@/views/admin/ProjectSettingsView.vue')
      },
      {
        path: 'creator-grants',
        name: 'CreatorGrants',
        component: () => import('@/views/admin/CreatorGrantsView.vue')
      },
      {
        path: 'sources',
        name: 'SourceRegistry',
        component: () => import('@/views/admin/SourcesView.vue')
      },
      {
        path: 'gate-rules',
        name: 'GateRules',
        component: () => import('@/views/admin/GateRulesView.vue')
      },
      {
        path: 'projects/:projectId/arbitration/:pageId',
        name: 'Arbitration',
        component: () => import('@/views/admin/ArbitrationView.vue')
      }
    ]
  },
  {
    path: '/tasks',
    component: () => import('@/views/proofreader/ProofreaderLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'TaskHall',
        component: () => import('@/views/proofreader/TaskHallView.vue')
      },
      {
        path: 'profile',
        name: 'ProofreaderProfile',
        component: () => import('@/views/proofreader/ProfileView.vue')
      },
      {
        path: ':id/edit',
        name: 'ProofreadEditor',
        component: () => import('@/views/proofreader/ProofreadEditorView.vue')
      }
    ]
  },
  {
    path: '/projects',
    name: 'ProjectDiscovery',
    component: () => import('@/views/ProjectDiscoveryView.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// ✅ 修复核心：直接用 pb.authStore 判断（不是 store）
router.beforeEach((to) => resolveNavigation(to, getAuthState()))

export default router
