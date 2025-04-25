<script lang="ts" setup>
if (useUserSession().loggedIn.value === false) {
  await navigateTo('/admin/login');
}

async function logout() {
  try {
    await useUserSession().clear();
    location.reload();
  } catch (error) {
    console.error(error);
    alert('Failed to log out');
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 p-4">
    <div class="flex justify-between items-center mb-4 border-b pb-2">
      <NuxtLink to="/admin">
        <h1 class="text-lg font-medium text-gray-800">Admin Panel</h1>
      </NuxtLink>
      <button
        @click="logout"
        class="text-sm text-gray-600 hover:cursor-pointer hover:text-gray-900 border px-2 py-0.5 rounded"
      >
        Log out
      </button>
    </div>
    <slot />
  </div>
</template>
