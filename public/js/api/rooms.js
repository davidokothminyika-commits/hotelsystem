/**
 * public/js/api/rooms.js
 *
 * WHAT THIS MODULE DOES
 * Wrappers for room browsing, availability search and room types.
 *
 * COMMUNICATION
 * Rooms page, booking form -> THIS FILE -> /api/rooms/*
 */
import api from './api.js';

export const roomsApi = {
    /**
     * Searches rooms available for a date window.
     *
     * The availability test happens in the database, not in the browser, so
     * the result is authoritative. Filtering only on the client would let a
     * room that is already taken be offered for booking.
     */
    availability: (params = {}) => api.get('/rooms/availability', { query: params }),

    /** General listing for the admin rooms table. */
    list: (params = {}) => api.get('/rooms', { query: params }),

    detail: (id) => api.get(`/rooms/${id}`),

    /** Occupied nights for a room, used by the booking calendar. */
    calendar: (id, params = {}) => api.get(`/rooms/${id}/calendar`, { query: params }),

    roomTypes: () => api.get('/rooms/types'),

    amenities: () => api.get('/rooms/amenities'),

    statusCounts: () => api.get('/rooms/status-counts'),

    // ---- Administrative ----
    create: (payload) => api.post('/rooms', payload),
    update: (id, payload) => api.patch(`/rooms/${id}`, payload),
    updateStatus: (id, status) => api.patch(`/rooms/${id}/status`, { status }),
    remove: (id) => api.delete(`/rooms/${id}`),
};

export default roomsApi;