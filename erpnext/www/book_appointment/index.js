// Guards against out-of-order slot responses: a slow fetch for an earlier date
// must not overwrite the slots of the date the visitor has since chosen.
let slot_request_id = 0;

frappe.ready(async () => {
	initialise_select_date();
});

async function initialise_select_date() {
	navigate_to_page(1);
	await get_global_variables();
	setup_moment_locale();
	setup_date_picker();
	setup_timezone_selector();
	disable_next_button();
}

async function get_global_variables() {
	// Using await through this file instead of then.
	window.appointment_settings = (
		await frappe.call({
			method: "erpnext.www.book_appointment.index.get_appointment_settings",
		})
	).message;
	window.timezones = (
		await frappe.call({
			method: "erpnext.www.book_appointment.index.get_timezones",
		})
	).message;
}

// Dates and times are shown to the visitor, so format them in the language of
// the page rather than in the default English of moment.
function setup_moment_locale() {
	const lang = document.documentElement.lang || (frappe.boot && frappe.boot.lang);
	if (lang) {
		moment.locale(lang);
	}
}

// Mirror user-facing outcomes into the live region of the page. The toast
// container of Frappe has no aria-live, so alerts alone are never announced.
function announce(message) {
	let status = document.getElementById("booking-status");
	if (status) {
		status.textContent = message;
	}
}

function setup_timezone_selector() {
	let timezones_element = document.getElementById("appointment-timezone");
	let local_timezone = moment.tz.guess();
	timezones_element.textContent = "";
	window.timezones.forEach((timezone) => {
		let opt = document.createElement("option");
		opt.value = timezone;
		if (timezone == local_timezone) {
			opt.selected = true;
		}
		opt.textContent = timezone;
		timezones_element.appendChild(opt);
	});
}

function setup_date_picker() {
	let date_picker = document.getElementById("appointment-date");
	let today = new Date();
	// Build the bounds from local date parts. toISOString() converts to UTC
	// first, which lands a day early for any timezone ahead of it.
	date_picker.min = to_local_date_string(today);
	today.setDate(today.getDate() + window.appointment_settings.advance_booking_days);
	date_picker.max = to_local_date_string(today);
}

function to_local_date_string(date) {
	let month = String(date.getMonth() + 1).padStart(2, "0");
	let day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function disable_next_button() {
	let next_button = document.getElementById("next-button");
	next_button.disabled = true;
	next_button.onclick = null;
}

function show_next_button() {
	let next_button = document.getElementById("next-button");
	next_button.disabled = false;
	next_button.onclick = setup_details_page;
}

function on_date_or_timezone_select() {
	let date_picker = document.getElementById("appointment-date");
	let timezone = document.getElementById("appointment-timezone");
	// A partially typed date reports an empty value on every keystroke. Clear
	// the slots and wait, rather than interrupting with an error dialog.
	if (date_picker.value === "") {
		clear_time_slots();
		disable_next_button();
		return;
	}
	window.selected_date = date_picker.value;
	window.selected_timezone = timezone.value;
	update_time_slots(date_picker.value, timezone.value);
	let lead_text = document.getElementById("lead-text");
	lead_text.textContent = __("Select Time");
}

async function get_time_slots(date, timezone) {
	let slots = (
		await frappe.call({
			method: "erpnext.www.book_appointment.index.get_appointment_slots",
			args: {
				date: date,
				timezone: timezone,
			},
		})
	).message;
	return slots;
}

async function update_time_slots(selected_date, selected_timezone) {
	let timeslot_container = document.getElementById("timeslot-container");
	let request_id = ++slot_request_id;

	disable_next_button();
	show_timeslot_message(__("Loading available times..."));
	timeslot_container.setAttribute("aria-busy", "true");

	let slots;
	try {
		slots = await get_time_slots(selected_date, selected_timezone);
	} catch (error) {
		if (request_id !== slot_request_id) return;
		timeslot_container.removeAttribute("aria-busy");
		let message = __("Could not load available times. Please try again.");
		show_timeslot_message(message, true);
		announce(message);
		return;
	}

	// A newer date was picked while this response was in flight; discard it.
	if (request_id !== slot_request_id) return;

	window.slots = slots;
	timeslot_container.removeAttribute("aria-busy");

	if (!window.slots || window.slots.length <= 0) {
		let message = __("There are no slots available on this date");
		show_timeslot_message(message);
		announce(message);
		return;
	}

	clear_time_slots();
	window.slots.forEach((slot) => {
		timeslot_container.appendChild(get_timeslot_div_layout(slot));
	});
	set_default_timeslot();
}

function show_timeslot_message(message, is_error) {
	let timeslot_container = document.getElementById("timeslot-container");
	clear_time_slots();
	let message_div = document.createElement("p");
	message_div.className = is_error ? "timeslot-message is-error" : "timeslot-message";
	message_div.textContent = message;
	timeslot_container.appendChild(message_div);
}

function get_timeslot_div_layout(timeslot) {
	let times = get_slot_times(timeslot.time);
	let timeslot_div = document.createElement("div");
	timeslot_div.classList.add("time-slot");
	timeslot_div.setAttribute("role", "button");
	timeslot_div.setAttribute("aria-pressed", "false");
	if (!timeslot.availability) {
		timeslot_div.classList.add("unavailable");
		timeslot_div.setAttribute("aria-disabled", "true");
		timeslot_div.tabIndex = -1;
	} else {
		timeslot_div.tabIndex = 0;
	}
	timeslot_div.innerHTML = get_slot_layout(times);
	timeslot_div.id = timeslot.time.substring(11, 19);
	// Name the whole range, matching what the slot shows, and carry
	// unavailability in the name as well as in the strike-through.
	timeslot_div.setAttribute(
		"aria-label",
		timeslot.availability
			? __("{0} to {1}", [times.start, times.end])
			: __("{0} to {1} (unavailable)", [times.start, times.end])
	);
	timeslot_div.addEventListener("click", select_time);
	timeslot_div.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			select_time.call(timeslot_div);
		}
	});
	return timeslot_div;
}

function clear_time_slots() {
	// Clear any existing divs in timeslot container
	let timeslot_container = document.getElementById("timeslot-container");
	while (timeslot_container.firstChild) {
		timeslot_container.removeChild(timeslot_container.firstChild);
	}
}

function get_slot_times(time) {
	let timezone = document.getElementById("appointment-timezone").value;
	let start_time = moment(new Date(time)).tz(timezone);
	let end_time = start_time.clone().add(window.appointment_settings.appointment_duration, "minutes");
	return { start: start_time.format("LT"), end: end_time.format("LT") };
}

function get_slot_layout(times) {
	return `<span class="time-slot-start">${times.start}</span><br><span class="text-muted small">${__(
		"to"
	)} ${times.end}</span>`;
}

function select_time() {
	if (this.classList.contains("unavailable")) {
		return;
	}
	// getElementsByClassName returns a LIVE collection, so capture the element
	// before mutating its class (removing "selected" would empty the list).
	let previous = document.getElementsByClassName("selected")[0];
	if (previous) {
		previous.classList.remove("selected");
		previous.setAttribute("aria-pressed", "false");
	}
	window.selected_time = this.id;
	this.classList.add("selected");
	this.setAttribute("aria-pressed", "true");
	show_next_button();
}

function set_default_timeslot() {
	let timeslots = document.getElementsByClassName("time-slot");
	// Can't use a forEach here since, we need to break the loop after a timeslot is selected
	for (let i = 0; i < timeslots.length; i++) {
		const timeslot = timeslots[i];
		if (!timeslot.classList.contains("unavailable")) {
			timeslot.classList.add("selected");
			timeslot.setAttribute("aria-pressed", "true");
			window.selected_time = timeslot.id;
			// The slot is shown as chosen, so Next has to accept it. Leaving the
			// button disabled here states a selection the page then refuses.
			show_next_button();
			break;
		}
	}
}

function navigate_to_page(page_number) {
	let page1 = document.getElementById("select-date-time");
	let page2 = document.getElementById("enter-details");
	switch (page_number) {
		case 1:
			page1.style.display = "block";
			page2.style.display = "none";
			focus_heading("select-date-time-heading");
			break;
		case 2:
			page1.style.display = "none";
			page2.style.display = "block";
			focus_heading("enter-details-heading");
			break;
		default:
			break;
	}
}

// Both steps live in one document, so hiding one strands keyboard focus on an
// element that is no longer displayed. Move it to the heading of the new step.
function focus_heading(heading_id) {
	let heading = document.getElementById(heading_id);
	if (heading) {
		heading.focus();
	}
}

function setup_details_page() {
	navigate_to_page(2);
	setup_search_params();
	let slot_text = document.getElementById("selected-slot-text");
	// One translated sentence: split across spans, it pins English word order
	// onto every other language.
	slot_text.textContent = __("Selected date is {0} at {1}", [
		moment(window.selected_date).format("LL"),
		moment(window.selected_time, "HH:mm:ss").format("LT"),
	]);
}

function setup_search_params() {
	let search_params = new URLSearchParams(window.location.search);
	let customer_name = search_params.get("name");
	let customer_email = search_params.get("email");
	let detail = search_params.get("details");
	// readOnly, not disabled: a disabled field is skipped by the keyboard and
	// announced as unavailable, yet these values are still being submitted.
	if (customer_name) {
		let name_input = document.getElementById("customer_name");
		name_input.value = customer_name;
		name_input.readOnly = true;
	}
	if (customer_email) {
		let email_input = document.getElementById("customer_email");
		email_input.value = customer_email;
		email_input.readOnly = true;
	}
	if (detail) {
		let detail_input = document.getElementById("customer_notes");
		detail_input.value = detail;
		detail_input.readOnly = true;
	}
}

async function submit() {
	let button = document.getElementById("submit-button");
	let form = document.querySelector("#customer-form");
	if (!form.checkValidity()) {
		form.reportValidity();
		return;
	}

	let idle_label = button.textContent;
	set_submit_pending(button, true);

	let contact = get_form_data();
	frappe.call({
		method: "erpnext.www.book_appointment.index.create_appointment",
		args: {
			date: window.selected_date,
			time: window.selected_time,
			contact: contact,
			tz: window.selected_timezone,
		},
		callback: (response) => {
			let message =
				response.message.status == "Unverified"
					? __("Please check your email to confirm the appointment")
					: __("Appointment created successfully");
			frappe.show_alert(message);
			announce(message);
			setTimeout(() => {
				let redirect_url = "/book_appointment";
				if (window.appointment_settings.success_redirect_url) {
					redirect_url = `/${window.appointment_settings.success_redirect_url}`;
				}
				window.location.href = redirect_url;
			}, 5000);
		},
		error: () => {
			let message = __("Something went wrong, please try again");
			frappe.show_alert(message);
			announce(message);
			set_submit_pending(button, false, idle_label);
		},
	});
}

function set_submit_pending(button, pending, idle_label) {
	button.disabled = pending;
	button.setAttribute("aria-busy", pending ? "true" : "false");
	button.textContent = pending ? __("Submitting...") : idle_label;
}

function get_form_data() {
	let contact = {};
	let inputs = ["name", "number", "notes", "email"];
	inputs.forEach((id) => (contact[id] = document.getElementById(`customer_${id}`).value));
	return contact;
}
