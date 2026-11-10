// Read a picked image file as base64 (same shape the original client
// sent: { dataBase64, mimeType }). Replaces fileToBase64 from the Hatch SDK.
export async function fileToBase64(file: File): Promise<{ dataBase64: string; mimeType: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
  const dataBase64 = dataUrl.split(",")[1] ?? "";
  return { dataBase64, mimeType: file.type };
}
