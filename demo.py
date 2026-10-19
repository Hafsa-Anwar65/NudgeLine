"""Ready-made example results for the demo mode (no account, no AI key, nothing written to disk)."""

DEMO_META = {"source": "sample leads (demo)", "tone": "friendly", "model": "example drafts (demo)", "seconds": 4.2, "demo": True}
OPT = "If this isn't relevant, just reply 'no' and I won't email again."

DEMO_ROWS = [
    {"id": "d1", "priority": "high", "intent_score": "5", "language": "English", "name": "Sara Khan", "company": "Sweet Crumbs Bakery",
     "email": "sara@example-bakery.com", "post_url": "", "post_text": "Looking for someone who can build a simple website for my bakery. Need online ordering if possible.",
     "comment": "A simple site with online ordering is very doable for a bakery. Happy to share a couple of ideas if that would help.",
     "comment_note": "", "subject": "Online ordering for Sweet Crumbs",
     "body": "Hi Sara,\n\nI saw your post about wanting a simple website with online ordering for the bakery. That is exactly the kind of project I enjoy: clean, fast and easy for customers to order from.\n\nI build business websites for small businesses. If it helps, I can send a short outline of how I would set it up.\n\nBest,\nDemo User\n\n" + OPT,
     "personalization": "post", "angle": "", "qa_flags": "", "status": "draft"},
    {"id": "d2", "priority": "high", "intent_score": "5", "language": "Roman Urdu", "name": "Dr. Ahmed", "company": "City Care Clinic",
     "email": "ahmed@example-clinic.com", "post_url": "", "post_text": "Mujhe apne clinic ke liye website chahiye, koi achha developer batao please.",
     "comment": "Clinic ki website mein appointment booking aur clear services page sab se zyada kaam aate hain. Main madad kar sakta hoon agar aap chahein.",
     "comment_note": "", "subject": "Clinic website ke liye idea",
     "body": "Assalam o Alaikum Dr. Ahmed,\n\nAap ki post dekhi ke clinic ke liye website chahiye. Main chhote businesses ke liye simple aur tez websites banata hoon, jis mein appointment booking bhi ho sakti hai.\n\nAgar aap chahein to main ek chhota sa plan bhej doon?\n\nShukriya,\nDemo User\n\n" + OPT,
     "personalization": "post", "angle": "", "qa_flags": "", "status": "draft"},
    {"id": "d3", "priority": "medium", "intent_score": "4", "language": "English", "name": "Ayesha Malik", "company": "Glow Salon",
     "email": "ayesha@example-salon.com", "post_url": "", "post_text": "Our salon is growing and we need an online booking page for customers.",
     "comment": "Congrats on the growth! A simple booking page can save a lot of back and forth with customers!!",
     "comment_note": "", "subject": "Booking page for Glow Salon",
     "body": "Hi Ayesha,\n\nCongratulations on the salon growing. You mentioned needing an online booking page, and I can build a clean one that lets customers pick a time without calling.\n\nWould you like a quick example of how it could look?\n\nBest,\nDemo User\n\n" + OPT,
     "personalization": "post", "angle": "", "qa_flags": "contains an exclamation mark in the comment", "status": "needs_edit"},
    {"id": "d4", "priority": "low", "intent_score": "1", "language": "English", "name": "Bilal", "company": "Spice Route",
     "email": "bilal@example-restaurant.com", "post_url": "", "post_text": "Just had the best biryani in town, highly recommend!",
     "comment": "", "comment_note": "skipped: not a request for a service", "subject": "", "body": "",
     "personalization": "", "angle": "This post is a restaurant recommendation, not a need for a website.", "qa_flags": "", "status": "skipped"},
    {"id": "d5", "priority": "medium", "intent_score": "3", "language": "English", "name": "Usman", "company": "Iron Works Gym",
     "email": "not-an-email", "post_url": "", "post_text": "Anyone know a good web designer for a small gym?",
     "comment": "A small gym site with class times and a sign-up form usually does the job. Glad to share some examples.",
     "comment_note": "", "subject": "", "body": "", "personalization": "", "angle": "No valid email, so only a comment was written.",
     "qa_flags": "", "status": "draft"},
]
