<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const config = useRuntimeConfig();

const source = ref({
  name: '',
  url: '',
  category: '',
  description: '',
  paywall: false,
});

const categories = ['geopolitics', 'french news', 'tech', 'good news', 'other'];

const handleSubmit = async () => {
  try {
    const response = await fetch(`${config.public.WORKER_API}/sources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(source.value),
    });

    if (!response.ok) {
      throw new Error('Failed to add source');
    }

    router.push('/sources');
  } catch (error) {
    console.error('Error adding source:', error);
    // TODO: Add proper error handling/notification
  }
};

useSEO({
  title: 'add source | meridian',
  description: 'add a new news source to your daily brief',
});
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <h1 class="text-2xl font-bold mb-6">Add New Source</h1>

    <form @submit.prevent="handleSubmit" class="space-y-4">
      <div>
        <label for="name" class="block text-sm font-medium text-gray-700">Source Name</label>
        <input
          type="text"
          id="name"
          v-model="source.name"
          required
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
        />
      </div>

      <div>
        <label for="url" class="block text-sm font-medium text-gray-700">URL</label>
        <input
          type="url"
          id="url"
          v-model="source.url"
          required
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
        />
      </div>

      <div>
        <label for="category" class="block text-sm font-medium text-gray-700">Category</label>
        <select
          id="category"
          v-model="source.category"
          required
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
        >
          <option value="">Select a category</option>
          <option v-for="category in categories" :key="category" :value="category">
            {{ category }}
          </option>
        </select>
      </div>

      <div>
        <label for="description" class="block text-sm font-medium text-gray-700">Description</label>
        <textarea
          id="description"
          v-model="source.description"
          rows="3"
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
        ></textarea>
      </div>

      <div class="flex items-center">
        <input
          type="checkbox"
          id="paywall"
          v-model="source.paywall"
          class="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
        <label for="paywall" class="ml-2 block text-sm text-gray-700"> This source has a paywall </label>
      </div>

      <div class="flex justify-end">
        <button
          type="submit"
          class="inline-flex justify-center rounded-md border border-transparent bg-indigo-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          Add Source
        </button>
      </div>
    </form>
  </div>
</template>
